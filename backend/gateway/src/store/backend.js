// Wallet-store persistence backends, selected by STORE_BACKEND.
//
//   file   (default) — the flat-file store: a whole-store synchronous, fsync'd,
//                      atomic write. Coalesced within txn() to one write per op.
//   sqlite            — ACID DB (Node built-in node:sqlite, Node ≥22). Targeted
//                      per-wallet transactional upserts; the money invariants are
//                      DB constraints. See docs/DB-MIGRATION.md and schema.sql.
//
// wallet.js keeps ALL its business logic; it only calls these to persist. Both
// backends expose the same surface:
//   load() -> { wallets, idempotency }
//   txn(fn)                        run fn atomically (file: coalesce writes)
//   saveWallet(store, user)        persist one wallet (+its ledger/holds)
//   saveWallets(store, users)      persist several wallets atomically
//   dropWallet(store, user)        delete a wallet
//   saveIdem(store, key)           persist one idempotency entry
//   dropIdem(store, key)           delete one idempotency entry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export function makeStoreBackend(opts) {
  return process.env.STORE_BACKEND === 'sqlite' ? sqliteBackend(opts) : fileBackend(opts);
}

/* ── file backend: whole-store synchronous atomic write ───────────────────── */
function fileBackend({ storePath, storeKey, encryptStore, decryptStore }) {
  let inTxn = false, dirty = false;

  function writeAll(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    const json = JSON.stringify(store);
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, storeKey ? encryptStore(json) : json); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, storePath);
  }
  // Every save/drop is a whole-store write; inside a txn we set a dirty flag and
  // write once at commit, so an operation still costs exactly one fsync.
  const mark = (store) => { if (inTxn) { dirty = true; _store = store; } else writeAll(store); };
  let _store = null;

  return {
    load() {
      try {
        const raw = fs.readFileSync(storePath, 'utf8');
        if (raw.startsWith('NFE1:')) {
          if (!storeKey) throw new Error('store is encrypted but WALLET_STORE_KEY is not set');
          return JSON.parse(decryptStore(raw));
        }
        return JSON.parse(raw);
      } catch (err) {
        if (String(err.message).includes('WALLET_STORE_KEY')) throw err; // never silently reset an encrypted store
        return { wallets: {}, idempotency: {} };
      }
    },
    txn(fn) {
      if (inTxn) return fn();
      inTxn = true; dirty = false; _store = null;
      try { const r = fn(); if (dirty && _store) writeAll(_store); return r; }
      finally { inTxn = false; }
    },
    saveWallet(store) { mark(store); },
    saveWallets(store) { mark(store); },
    dropWallet(store) { mark(store); },
    saveIdem(store) { mark(store); },
    dropIdem(store) { mark(store); },
  };
}

/* ── sqlite backend: ACID, per-wallet transactional upserts ────────────────── */
function sqliteBackend({ dbPath }) {
  // node:sqlite is Node ≥22 only. createRequire works on Node 20 too, so the file
  // backend never trips on this import — only an actual sqlite backend needs 22.
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); }
  catch (e) { throw new Error('STORE_BACKEND=sqlite needs Node >=22 (built-in node:sqlite): ' + e.message); }
  const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const S = {
    wUpsert: db.prepare(`INSERT INTO wallets (user_id,paid,free,held,frozen,plan_id,plan_status,plan_since,plan_renewed_at,plan_canceled_at,claimed_by,created_at)
                         VALUES (@user_id,@paid,@free,@held,@frozen,@plan_id,@plan_status,@plan_since,@plan_renewed_at,@plan_canceled_at,@claimed_by,@created_at)
                         ON CONFLICT(user_id) DO UPDATE SET paid=@paid,free=@free,held=@held,frozen=@frozen,plan_id=@plan_id,plan_status=@plan_status,plan_since=@plan_since,plan_renewed_at=@plan_renewed_at,plan_canceled_at=@plan_canceled_at,claimed_by=@claimed_by`),
    wDelete: db.prepare('DELETE FROM wallets WHERE user_id=?'),
    lDelete: db.prepare('DELETE FROM ledger WHERE user_id=?'),
    lInsert: db.prepare(`INSERT INTO ledger (user_id,ts,label,amt,type,pool,balance_before,balance_after,bracket_factor,reversal_requested,shortfall,reference_id)
                         VALUES (@user_id,@ts,@label,@amt,@type,@pool,@balance_before,@balance_after,@bracket_factor,@reversal_requested,@shortfall,@reference_id)`),
    hDelete: db.prepare('DELETE FROM holds WHERE user_id=?'),
    hInsert: db.prepare('INSERT INTO holds (user_id,key,amount,created_at) VALUES (?,?,?,?)'),
    iUpsert: db.prepare('INSERT INTO idempotency (key,result_json,created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET result_json=excluded.result_json'),
    iDelete: db.prepare('DELETE FROM idempotency WHERE key=?'),
    allW: db.prepare('SELECT * FROM wallets'),
    allL: db.prepare('SELECT * FROM ledger ORDER BY user_id, id DESC'),
    allH: db.prepare('SELECT * FROM holds'),
    allI: db.prepare('SELECT key, result_json FROM idempotency'),
  };
  const i = (v) => Math.trunc(Number(v) || 0);

  function upsertWalletRow(user, w) {
    if (!w) return;
    const p = w.plan || {};
    S.wUpsert.run({
      user_id: user, paid: i(w.paid), free: i(w.free), held: i(w.held || 0), frozen: w.frozen ? 1 : 0,
      plan_id: p.id ?? null, plan_status: p.status ?? null, plan_since: p.since ?? null,
      plan_renewed_at: p.renewedAt ?? null, plan_canceled_at: p.canceledAt ?? null,
      claimed_by: w.claimedBy ?? null, created_at: i(w.createdAt || Date.now()),
    });
    // Rewrite this wallet's ledger + holds (bounded: ledger is capped at 500).
    // Insert OLDEST first so the newest row gets the highest id; load reads
    // id DESC to restore the in-memory newest-first order.
    S.lDelete.run(user);
    const led = w.ledger || [];
    for (let k = led.length - 1; k >= 0; k--) {
      const e = led[k];
      S.lInsert.run({
        user_id: user, ts: i(e.ts), label: e.t ?? null, amt: i(e.amt), type: e.type ?? null, pool: e.pool ?? null,
        balance_before: e.balanceBefore ?? null, balance_after: e.balanceAfter ?? null, bracket_factor: e.bracketFactor ?? null,
        reversal_requested: e.reversalRequested ?? null, shortfall: e.shortfall ?? null, reference_id: e.referenceId ?? null,
      });
    }
    S.hDelete.run(user);
    for (const [key, amt] of Object.entries(w.holds || {})) S.hInsert.run(user, key, i(amt), i(w.createdAt || Date.now()));
  }

  let depth = 0;
  function txn(fn) {
    if (depth > 0) return fn();
    depth++; db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { depth--; }
  }

  return {
    load() {
      const wallets = {};
      for (const r of S.allW.all()) {
        const w = { paid: Number(r.paid), free: Number(r.free), createdAt: Number(r.created_at), ledger: [], holds: {} };
        if (Number(r.held) > 0) w.held = Number(r.held);
        if (r.frozen) w.frozen = true;
        if (r.claimed_by != null) w.claimedBy = r.claimed_by;
        if (r.plan_id != null) {
          w.plan = { id: r.plan_id, status: r.plan_status, since: r.plan_since != null ? Number(r.plan_since) : undefined, renewedAt: r.plan_renewed_at != null ? Number(r.plan_renewed_at) : undefined };
          if (r.plan_canceled_at != null) w.plan.canceledAt = Number(r.plan_canceled_at);
        }
        wallets[r.user_id] = w;
      }
      for (const r of S.allL.all()) {
        const w = wallets[r.user_id]; if (!w) continue;
        const e = { t: r.label, amt: Number(r.amt), ts: Number(r.ts), balanceBefore: r.balance_before != null ? Number(r.balance_before) : undefined, balanceAfter: r.balance_after != null ? Number(r.balance_after) : undefined, type: r.type ?? undefined, pool: r.pool ?? undefined, bracketFactor: r.bracket_factor != null ? Number(r.bracket_factor) : undefined };
        if (r.reference_id != null) e.referenceId = r.reference_id;
        if (r.reversal_requested != null) e.reversalRequested = Number(r.reversal_requested);
        if (r.shortfall != null) e.shortfall = Number(r.shortfall);
        w.ledger.push(e); // rows arrive newest-first (id DESC) → matches in-memory unshift order
      }
      for (const r of S.allH.all()) { const w = wallets[r.user_id]; if (w) { w.holds = w.holds || {}; w.holds[r.key] = Number(r.amount); } }
      const idempotency = {};
      for (const r of S.allI.all()) { try { idempotency[r.key] = JSON.parse(r.result_json); } catch { /* skip corrupt */ } }
      return { wallets, idempotency };
    },
    txn,
    saveWallet(store, user) { txn(() => upsertWalletRow(user, store.wallets[user])); },
    saveWallets(store, users) { txn(() => { for (const u of users) upsertWalletRow(u, store.wallets[u]); }); },
    dropWallet(store, user) { txn(() => S.wDelete.run(user)); }, // ledger/holds cascade via FK
    saveIdem(store, key) { S.iUpsert.run(key, JSON.stringify(store.idempotency[key]), Date.now()); },
    dropIdem(store, key) { S.iDelete.run(key); },
  };
}
