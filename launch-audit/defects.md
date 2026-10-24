# Defects

One record per defect. All found this audit. Severity: P0 catastrophic · P1 critical ·
P2 high · P3 medium · P4 low.

> Note: P0/P1 security + hygiene defects found in the PRIOR audit cycles of this session
> (admin-auth bypass C1, denial-of-wallet, IDOR-by-default, demo-data-to-prod, Node-20 EOL,
> committed runtime state) were already FIXED and pushed — see the session's earlier commits.
> This file records what the live MASTER-PROMPT-v2 execution surfaced.

---
### D-01 — Oversized request body closes the socket instead of returning 413
- Severity: **P4** (robustness). Blocker: No.
- Area: gateway body reader (`server.js` readBody, ~line 345).
- Evidence: `evidence/adversarial-run.txt` — a >2 MB POST aborts the connection
  mid-upload (`UND_ERR_SOCKET`) rather than responding `413`. The body **is** rejected
  (DoS protection works); the client just sees a reset.
- Impact: a legitimate client sending too much data sees a connection error, not a clear
  "too large" message. No security impact.
- Fix path: send a `413` response then end the request before destroying the socket.
- Status: **OPEN (P4, non-blocking)** — logged, not yet patched.

---
### D-02 — "Deterministic scoring / pure function" overstates the PAID search path
- Severity: **P3** (truth-in-marketing). Blocker: No.
- Area: blog copy (`nf-articles.js` deterministic-scoring article) + any "identical inputs →
  identical scores" claim; `search.html` NICHE_SCHEMA.
- Evidence: `truth-audit.md` #3. The free score is a genuine pure function; the paid
  search's pillar + confidence scores are produced by the AI model against a fixed rubric
  (not a separate pure function), so they are calibrated + data-grounded but not
  bit-reproducible.
- Fix applied: paid-path copy softened across all 6 spots in `nf-articles.js` to "scored
  against a fixed, published three-pillar rubric, grounded in real country data"; the
  genuine determinism claim is retained only where true (the free homepage score is a pure
  function). No false reproducibility claim remains for the paid search.
- Status: **FIXED**.

---
### D-03 — KODA webhook has no timestamp / replay-window check (Stripe does)
- Severity: **P3**. Blocker: No (replay bounded by idempotent `koda_${order_id}` credit).
- Area: `koda.js:154-162` verifies HMAC only; `payments.js` (Stripe) also rejects stale ts.
- Evidence: security re-audit M1.
- Fix path: include a signed timestamp in the KODA scheme and reject deliveries outside a
  tolerance window. **Needs KODA's signing spec** → `human-actions.md`.
- Status: **OPEN (P3)** — blocked on external info.

---
### D-04 — Cookie-consent banner overlaps content on first load (mobile)
- Severity: **P4** (UX). Blocker: No.
- Evidence: shots `01`/`03` — the consent bar overlays the free-score result / niche cards
  on first visit until dismissed.
- Fix path: reserve space / anchor the banner so it never covers primary content; or defer
  until after first interaction.
- Status: **OPEN (P4)**.

---
### D-05 — Freshly-credited wallet can be clicked before it syncs (Mind-2 race)
- Severity: **P4** (UX edge). Blocker: No.
- Evidence: walkthrough J3 first run — clicking Generate immediately after an out-of-band
  credit opened the top-up modal because `NF.wallet().paid` hadn't synced yet. In the real
  flow the credit arrives via a Stripe return that syncs the wallet, so this is an edge.
- Fix path: disable Generate until the first wallet sync completes, or re-check server
  balance on the 402 path before prompting top-up.
- Status: **OPEN (P4)**.
