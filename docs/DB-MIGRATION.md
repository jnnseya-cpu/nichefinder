# Money store: flat-file → SQLite migration design

**Status:** design + verified migration tool + **the storage adapter (phase 2) landed and tested**.
`wallet.js` now runs on either backend via `STORE_BACKEND` (default `file`,
unchanged); `sqlite` gives ACID transactions + durable commits + DB-enforced
invariants. Remaining before a production flip: the operational cutover (Node 22
upgrade, backfill, dual-run) and migrating auth/referrals (phase 3).
**Owner:** platform/eng. **Blocker addressed:** B2 (money on unbacked, non-transactional flat files).

## Why

The system of record is flat JSON (`wallet.js`, `auth.js`, `referrals.js`, …), each
loaded into memory and written back with a **debounced `persist()`**. For money
that is three concrete defects:

1. **Durability gap.** `persist()` debounces writes by 50 ms (`wallet.js`). A crash
   in that window loses committed charges/credits — real money mutations vanish.
2. **No atomicity across records.** A settlement touches a wallet + its ledger +
   a referral award across separate files; a crash mid-way leaves them
   inconsistent. There is no transaction.
3. **No queryability / single-writer ceiling.** Reconciliation means scanning
   JSON, and a single Node process is the only safe writer, so the platform can't
   run ≥2 replicas.

SQLite fixes 1–2 and the query gap immediately (ACID, WAL, durable commit, SQL).
Postgres later fixes 3 (multi-writer) for horizontal scale. The invariants that
today live only in JS — never-negative balance, `held ≤ paid`, exactly-once
settlement — become **DB constraints** that no future bug can violate (proven in
`test/dbmigrate.js`).

## Target architecture

- **Now:** SQLite via Node's built-in **`node:sqlite`** — zero external
  dependency, single file (the existing `nf-backup.sh` already snapshots it),
  ACID transactions. **Requires Node ≥ 22** on the VPS (currently Node 20 — a
  one-time `nodesource setup_22.x` upgrade; `engines` stays `>=20` for the
  file backend, `>=22` when `STORE_BACKEND=sqlite`).
- **Later (scale):** Postgres via `pg` (a real dependency, deferred until ≥2
  replicas are actually needed). The adapter interface below keeps the swap local.
- **Flagging:** a `STORE_BACKEND` env selects `file` (default, unchanged) or
  `sqlite`. Nothing changes until an operator opts in — no big-bang cutover.

```
STORE_BACKEND=file    # default — current flat-file behaviour, no change
STORE_BACKEND=sqlite  # ACID DB at WALLET_DB (default data/money.db)
```

## Schema

`backend/gateway/src/store/schema.sql` — `wallets`, `ledger` (append-only audit),
`holds` (reservations), `idempotency` (exactly-once settlement), `schema_meta`.
Money invariants are DB constraints: `CHECK (paid >= 0)`, `CHECK (held <= paid)`,
`idempotency.key PRIMARY KEY`. Follow-on tables (accounts/sessions/referrals) are
sketched in the same file for phase 2.

## Migration mechanics (backfill → verify → cutover → rollback)

The tool is `scripts/nf-migrate-store.mjs` (`migrateWalletStore(...)`), covered by
`test/dbmigrate.js`.

1. **Backfill.** Read `wallets.json` (decrypting an `NFE1` envelope with
   `WALLET_STORE_KEY` if set), insert every wallet/ledger/hold/idempotency row
   into SQLite in **one transaction**.
2. **Verify-before-commit.** Recount wallets, ledger rows, holds, idempotency
   keys and **sum paid + free**; commit only if they exactly match the JSON
   source, else **ROLLBACK**. All-or-nothing.
3. **Never mutates the source.** The JSON file is untouched, so it is the instant
   rollback: set `STORE_BACKEND=file` and restart.
4. **Refuses a non-empty target** so a re-run can't double-load.

### Cutover runbook (per box, brief maintenance)
```bash
# 0. Node 22 (one time): curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo systemctl stop nichefinder                              # freeze writes
sudo -E node scripts/nf-migrate-store.mjs \
     backend/gateway/data/wallets.json backend/gateway/data/money.db   # backfill + verify
# add to /etc/nichefinder.env:  STORE_BACKEND=sqlite   WALLET_DB=/opt/.../data/money.db
sudo systemctl start nichefinder
curl -s localhost:8080/v1/health                            # 200 ok
# smoke a read (GET /v1/wallet with a known id) and a metered action; reconcile
# /v1/admin/metrics revenue against Stripe. Keep wallets.json as the rollback.
```
**Rollback:** `STORE_BACKEND=file` + restart. Because migration never wrote to the
JSON, no money is lost. (After cutover, take a fresh JSON export before deleting
the file, so the rollback window stays open for a defined period.)

## Phase 2 — the storage adapter (LANDED)

`backend/gateway/src/store/backend.js` (`makeStoreBackend`) is the persistence
seam, selected by `STORE_BACKEND`. `wallet.js` keeps ALL its money logic and only
calls the backend to save/drop wallets + idempotency entries — so the two
implementations can never diverge on business rules. Proven by `test/wallet-sqlite.js`
(operations, restart durability incl. exactly-once keys, DB constraints) and by
running the full paycycle HTTP flow with `STORE_BACKEND=sqlite` — every money
assertion passes identically on both backends.

The original sketch below is what was built:

```
getWallet, charge, grant, credit, creditPlanAllotment, clawback,
reserve, settleHold, releaseHold, migratePaid, endPlan, isFrozen,
getLedger, summary, idempotent(key, fn)
```

- `file` adapter = today's `wallet.js` internals, unchanged.
- `sqlite` adapter runs each mutation in a **single SQL transaction** (so
  charge+ledger, or settlement+referral, are atomic — closing defect #2), and
  leans on the DB constraints instead of JS guards.
- `wallet.js` becomes a thin facade over the selected adapter, so `payments.js`,
  `koda.js`, `referrals.js`, `server.js` need **no changes** — the surface is
  identical.

**Dual-run validation (optional, recommended):** before flipping the default,
run the `sqlite` adapter in shadow — mirror each write to both backends and log
any divergence for a week — so the cutover is evidence-based, not hopeful.

## Immediate stop-gap (independent of the DB)

Until cutover, the 50 ms durability window (defect #1) can be closed by making the
wallet `persist()` synchronous for money mutations (write + `fsync` + rename per
change). Correctness beats the tiny throughput cost at launch scale. This is a
small, separate change and does not block the DB work.

## Testing

`test/dbmigrate.js` (in the suite, self-skips on Node < 22) proves: lossless
counts + balances, per-user ledger + reference-id preservation, hold + idempotency
migration, the DB rejecting a negative balance / `held>paid` / duplicate
settlement key, refusal to load a non-empty DB, the JSON source left intact, and
the encrypted-store round-trip (with wrong-key rejection). Phase 2 adds adapter
parity tests (file vs sqlite produce identical wallet views for the same op
sequence) and a crash-durability test (kill mid-write, assert no lost commit).
