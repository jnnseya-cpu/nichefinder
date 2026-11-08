# Stable State — locked snapshot

**Locked:** 2026-11-08 · branch `claude/niche-finder-overview-mj1rmw`
**Durable marker:** remote branch `stable-2026-11-08-lock` · **commit:** `c2cbc9e`
**Local annotated tag:** `stable-2026-11-08` (also at `c2cbc9e`; this session's GitHub App denies tag-ref pushes, so the remote marker is a branch — same immutable snapshot)

This file records a verified, stable point so nothing silently changes or drops.
Everything below was committed, pushed, and green at the moment of locking.

## Verification snapshot (at lock time)
| Check | Result |
|---|---|
| Working tree | **clean** — no uncommitted or untracked files |
| Local vs origin | **in sync** — all work pushed |
| Backend test suite | **37/37 pass**, run twice, deterministic (exit 0 both times) |
| `npm audit` | **0 vulnerabilities** |
| `npm ci --omit=dev` | in sync with `package.json` (exit 0) |
| Preflight | 🟢 **GO** |
| Stray processes | none |

## What is locked (this session's delivered work)
Reliability & billing
- `fix(billing)` — never charged for truncated/empty AI output (Search Canvas incident); structured-output guard + retry + hold release. Tests: `generate-output-guard`.

Security & hardening
- Denial-of-wallet circuit breaker on free previews; proof-of-work human gate on signup **and** login; legal entity corrected (JNN GLOBAL LTD, 15405437).
- Prod audit: referrals ownership gate, SEC_HEADERS on media/unsubscribe, docstore key hardening, startup guards (session-binding / encryption-key), **demo-data production guard**, repo hygiene (untracked runtime state, removed stray file, fixed preflight check).
- Platform moved off EOL Node 20 → **Node 22 LTS**.

Growth / content
- `feat(blog)` — 21 USP-led feature articles + upgraded article engine (USP callout, FAQ, BlogPosting+FAQPage+Breadcrumb JSON-LD).

Admin console
- Restored article/SEO/referrals/comms tools into the real `admin-console.html`.
- **Encrypted admin-managed API key store** (`secrets.js`) + **Admin → API Keys** UI (env-override-first, masked, AES-256-GCM). Tests: `secrets`.
- **Agents** governance tab (read-only registry + connector health).

Platform build
- **Connector wrapper** (`connector.js`, timeout/retry/breaker/telemetry). Tests: `connector`.
- **Agent registry** (`agents.manifest.js`, honest live/partial/proposed status). Tests: `agents`.
- **BitriPay** provider (`bitripay.js`, Stripe-style timestamped-HMAC webhook) + routes + top-up button. Tests: `bitripay`. ⚠ Confirm BitriPay's real API field/event names before go-live (same posture as KODA).
- SQL cutover verified (node:sqlite backend boots live); file backend stays the reversible default (`node:sqlite` is Node-22-experimental).

Docs
- `docs/AI-OS-BLUEPRINT-v2.md` (current-state reconciliation), `launch-audit/` (honest NO-GO-until-live-validated report + evidence), `docs/DB-MIGRATION.md` note, `DEPLOY-VPS.md` (REQUIRE_WALLET_SESSION, API-key store, Node 22).

## The "nothing silently changes" rules (already enforced in code)
- **Money** moves only through reserve→settle holds with an append-only ledger; `moneyleaks` proves refund/chargeback claw-back, idempotent webhooks, TOCTOU, zero ledger-diff.
- **Never charged for a failed/unusable AI result** — enforced in the billing path, test-locked.
- **No agent/UI shows as "live"** without a real implementation pointer (registry validator).
- **Demo data can never render on a real host**; env always overrides admin-set keys.
- **Secrets never committed**; runtime stores gitignored.

## Known items that still need a human (not code)
See `launch-audit/human-actions.md`: deploy + rollback drill; prod env incl. `REQUIRE_WALLET_SESSION=1`, `WALLET_STORE_KEY`, Stripe keys; VPS Node ≥ 22.23.4; live AI-key eval; live payment-sandbox run; load/DR drills; **Stripe webhook signing secret** matching the endpoint (keep the ~9 handled events, not all 238).

## To restore this exact state later
```
git fetch origin && git checkout stable-2026-11-08-lock    # or: git checkout c2cbc9e
```
Any follow-up work branches forward from here; this marker does not move.
