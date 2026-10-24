# Human / Operator Action List

Only a human or the operator (with production access, credentials, or a business
decision) can complete these. The code side is done and pushed; the moment each item
is supplied, the audit loop can resume and validate it live.

| # | Action | Why it blocks an unrestricted GO | What I'll do once it's available |
|---|---|---|---|
| 1 | **Deploy the RC + run deploy→smoke→rollback on the live box.** | The verdict only applies to a tested build; the deployed build has not been validated. | Re-run the adversarial + journey suite against the live URL; prove rollback. |
| 2 | **Set production env:** `PUBLIC_ORIGIN`, `WALLET_STORE_KEY` (64 hex), `ADMIN_API_KEY`, Stripe keys, **`REQUIRE_WALLET_SESSION=1`**. | Without these the gateway warns at startup; session-binding off = account-wallet IDOR. | Confirm via `/v1/admin/diag` and a live IDOR re-test. |
| 3 | **Upgrade VPS Node to ≥ 22.23.4 and restart.** | Node 20 is EOL (Oct-21 advisory). Repo pins are fixed; the box must be upgraded. | Verify `node -v` + health post-restart. |
| 4 | **Provide a live AI key (sandbox/limited) for an AI-quality + injection eval.** | AI output quality, hallucination, prompt-injection and tool-safety are UNTESTED on the real model (only mock plumbing tested). | Run an evaluation set (correct/adversarial/multilingual incl. French) and report metrics. |
| 5 | **Confirm live Stripe + KODA contracts/keys for a sandbox end-to-end payment.** | Real settlement, refund, chargeback and mobile-money pending/callback flows UNTESTED live. | Drive sandbox payments incl. the mobile-money pending/duplicate-callback cases. |
| 6 | **KODA webhook signing spec (does it include a timestamp?).** | Needed to add replay-window rejection (Defect D-03). | Implement + test the timestamp check. |
| 7 | ~~Decide the `admin.html`/`comms.html` prototype's fate.~~ **DONE** — both removed (prototype island; superseded by `admin-console.html`). Note: `/v1/admin/test-email` is now UI-less (endpoint retained, curl-able); the article-publish / GSC / referrals-overview UIs that lived only in `admin.html` are gone (endpoints retained) — port any you still want into `admin-console.html`. | — | — |
| 8 | ~~Decide on Defect D-02 (deterministic-scoring copy).~~ **DONE** — paid-path copy softened to "fixed, published rubric, grounded in real data"; free-score determinism kept (accurate). | — | — |
| 9 | **Run production load / soak at expected peak + set alert thresholds.** | Performance at scale, cost ceilings, and alerting are UNTESTED (no prod infra access). | Define workloads, run them, report p50/p95/p99 + recovery. |
| 10 | **Accessibility (WCAG 2.2 AA) + real-device cross-browser pass.** | Screen-reader / Safari-Firefox-real-device matrix not run. | Run axe + manual SR pass on critical journeys. |
| 11 | **Backup-restore + DR drill on real data; confirm all accounts (domain/DNS/cloud/providers) are org-owned, not personal.** | Recovery and ownership are operational facts I can't verify from here. | Validate a real restore into isolation; document RPO/RTO. |
| 12 | **Email deliverability (SPF/DKIM/DMARC in Hostinger DNS).** | Prior audit found missing SPF + duplicate DMARC (DNS = operator). | Re-check with a live send + headers. |
