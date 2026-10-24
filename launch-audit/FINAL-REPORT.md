# FINAL REPORT — Niche Finder Launch Audit (MASTER PROMPT v2)

## 1. Executive verdict
- **Verdict: NO-GO for public launch — because the release is NOT live-validated,** not
  because of an open code defect. No production/staging access, no live keys, and the
  deployed build has not been exercised (Section 0 of the prompt makes this the only honest
  verdict without that access).
- **The layers testable here all PASS:** build integrity, critical journey (end-to-end on
  mock), security controls, financial invariants, data integrity.
- Confidence in the **code/logic/security** layer: **high** (evidence-backed). Confidence in
  **production readiness**: **unestablished** (requires the Human Action List).
- RC SHA `b1bbd72` · branch `claude/niche-finder-overview-mj1rmw` · local instance · 1 live cycle.
- Hard-reality conclusion: *The code is in a GO-candidate state for everything that can be
  proven without production access. It cannot be called launch-ready until it is deployed and
  re-tested live, a real AI key and payment sandbox are exercised, and load/DR/rollback are
  drilled on the box. Those are operator actions, listed precisely in `human-actions.md`.*

## 2. Immediate launch blockers
| ID | Sev | Area | Blocker | Status |
|---|---|---|---|---|
| HA-1 | — | Deploy | Deployed build not validated (verdict applies only to a tested build) | Operator |
| HA-2 | — | Config | `REQUIRE_WALLET_SESSION=1` + keys must be set in prod | Operator |
| HA-9 | — | Perf | Load/soak at peak UNTESTED (no infra) | Operator |
| HA-4/5 | — | AI/Pay | Real-model + live-payment flows UNTESTED (no keys) | Operator |
No open **P0/P1 code defects.** Remaining code defects are P3/P4 (see `defects.md`).

## 3. Gate results
| Gate | Status | Basis |
|---|---|---|
| 1 Build integrity | **PASS** | 33/33 suites, deterministic (×3), `npm audit` 0, traceable SHA |
| 2 Truth & fitness | **PASS (non-blocking)** | All claims REAL/labeled; novice reaches value on mobile. D-02 copy nuance |
| 3 Critical functionality | **PASS (on mock)** | 9/9 journey on real browser; real-model path = HA-4 |
| 4 Security | **PASS (tested surface)** | 16/16 adversarial; IDOR enforced live; 0 open P0/P1. Needs HA-2 |
| 5 Data integrity | **PASS** | prepared SQL, migrations + restore drill in suite, owner isolation live |
| 6 Financial integrity | **PASS** | TOCTOU, idempotent webhooks, reconcile, zero-diff (money-leaks F1–F12) |
| 7 Performance | **BLOCKED** | No load infra/access — UNTESTED (HA-9) |
| 8 Reliability | **PARTIAL** | degrade/watchdog drills pass; live failure-injection = HA-9/11 |
| 9 Observability | **PARTIAL** | watchdog alert drill passes; live alert-to-person UNTESTED |
| 10 Privacy & compliance | **PARTIAL** | erasure test passes; live cross-system deletion UNTESTED (HA-11); legal pages present |
| 11 Operational readiness | **BLOCKED** | deploy/rollback/DR/ownership = operator (HA-1/11) |

## 4. Truth audit summary
12 headline claims traced (`truth-audit.md`): 9 REAL, 2 PARTIAL (deterministic-scoring copy
D-02; Government Mode not nav-linked), 1 REAL-labeled (illustrative landing figure). **Zero
STUBBED-as-real on money/critical paths.** Mock content is self-labeled in the UI.

## 5. Novice-user findings
Free score reachable in seconds; full ranked search after a sub-minute signup; all on a
390px viewport throttled to slow-3G, zero JS errors. Friction: D-04 (cookie banner overlap),
D-05 (wallet-sync race). No abandonment-class blocker found in the tested journeys. French
locale + real-device matrix NOT run (HA-10).

## 6. Coverage
Automated: 33 backend suites PASS. Live manual/scripted: 16 adversarial + 4 financial + 9
browser-journey checks PASS (29/29). NOT tested: real-model AI, live payments, load/soak,
cross-browser real devices, screen-reader, production deploy/rollback/DR (all in HA list).

## 7. Architecture & dependencies
Single Node ESM gateway serves static PWA + `/v1` API; Caddy TLS; file/SQLite stores; 3
runtime deps (0 vulns). SPOF: single VPS process (acceptable at launch scale; in-memory rate
limits don't survive horizontal scaling — noted). Ownership of domain/DNS/cloud/provider
accounts = operator to confirm (HA-11).

## 8. Security findings
0 open P0/P1. VERIFIED live: admin gate, IDOR/session binding, webhook sig+idempotency,
headers, safe CORS, path-traversal block, rate limiting, prepared SQL. Residual: HA-2
(enable session binding in prod), D-03 (KODA replay window), M2 (permissive CSP + token in
localStorage — documented hardening, not a launch blocker).

## 9. Functional & UX findings
Core journeys pass end-to-end on mock. Defects D-01/D-04/D-05 (all P4). No dead buttons,
broken links, orphaned forms or false-success toasts found (prior dead-code audit + this run).

## 10. Data & database findings
Prepared statements only; migrations validated + restore drill in suite; owner/tenant
isolation enforced live (IDOR 403s). Runtime stores correctly gitignored (fixed this session).

## 11. Payment & financial findings
Server-authoritative pricing; Stripe webhook signature + **idempotent replay** verified live;
TOCTOU over-spend impossible (3/12 concurrent); money-leaks F1–F12 green (refund/chargeback
claw-back, referral cap, proration, amount-mismatch). **Financial invariant: zero ledger
difference** (money-leaks F3). Live settlement = HA-5.

## 12. AI & agent findings
Plumbing, provider fallback chain, self-healing degrade, and the **never-charge-for-unusable-
output guard** are tested (mock + `ai-eval`/`claude-degrade`/`generate-output-guard`). **Real-
model quality, hallucination, prompt-injection and tool-safety: NOT TESTED (no live key, HA-4).**

## 13. Performance findings
**NOT TESTED** — no load infrastructure/access (HA-9). Targets to set before launch: API p95
< 500 ms, error < 0.5%, LCP < 2.5 s (4G), transaction success > 99.5%.

## 14. Observability & incident response
Watchdog detects outage → alerts → de-dups → recovers (drill suite PASS). Live alert delivery
to a named person UNTESTED (HA-9).

## 15. Fixes implemented (this session, pushed)
Security: referrals ownership gate + dashboard bearer; SEC_HEADERS on /v1/media + unsubscribe;
docstore key hardening; startup guards for session-binding/encryption-key. Safety: demo-data
production guard (no fabricated results on a real host). Reliability: never-charge-for-unusable-
output (search + documents). Hygiene: untracked runtime state, removed stray file, fixed a
false-NO-GO preflight check. Platform: Node 20→22 LTS. All green + pushed.

## 16. Unresolved risks
D-01/D-04/D-05 (P4, deferred), D-02/D-03 (P3, owner/external), plus every NOT-TESTED area in
§6 pending the Human Action List. Assumption: production is configured per DEPLOY-VPS.md.

## 17. Human Action List
See `human-actions.md` (12 items). Top 4 that gate an unrestricted GO: deploy+rollback drill,
prod env incl. `REQUIRE_WALLET_SESSION=1`, live AI-key eval, live payment-sandbox run.

## 18. Pre-launch action plan
- **Before any launch:** HA-1, HA-2, HA-3.
- **Before beta:** HA-4, HA-5, HA-7, HA-8, HA-12.
- **Before public launch:** HA-9, HA-10, HA-11.
- **Within 7 days:** patch D-01/D-04/D-05; decide D-02/D-03.
- **Within 30 days:** M2 CSP hardening; Redis-backed limits if scaling.

## 19. Launch configuration (recommended)
Enable: free score, search, documents, growth, payments (once HA-5 done). Env: billing
enforced, `REQUIRE_WALLET_SESSION=1`, all keys set. Flags: keep `admin.html` prototype
noindex/off (HA-7). Start invite-only/low-traffic until HA-9 load data exists. Rollback
trigger: 2-gate auto-rollback already wired; kill-switch = maintenance mode (`/v1/admin`).

## 20. Final decision
**"This release is not approved for public launch."** — on the sole, honest ground that it has
not been validated against a live production environment, real AI/payment integrations, or
load. Every layer that *can* be validated without that access has been, and passes. Supply the
Human Action List items and the loop resumes toward a GO.
