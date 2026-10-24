# Evidence Ledger

Instance: `http://127.0.0.1:8700` — gateway (MOCK model, billing enforced,
`REQUIRE_WALLET_SESSION=1`) serving the static frontend. RC SHA `b1bbd72`.
Raw logs in `evidence/`. Statuses: PASS · FAIL · PARTIAL · BLOCKED · NOT TESTED.

## A. Automated backend suite (`npm test`) — 33/33 PASS, deterministic (run ≥3×)
smoke · full-payment-cycle · quick-preview · market-data · showcase · **money-leaks
(F1–F12: replay, reservation clamp, refund/chargeback claw-back, referral cap, TOCTOU,
proration, settlement-key poison, amount-mismatch, wallet ownership, webhook sig)** ·
subscriptions · koda · auth+admin · mailer · referrals · newsletter · migrate · articles ·
capi · search-console · headers · metrics · backup · smoke-gate · **drill (watchdog
outage→alert→recover)** · db-migration · wallet-sqlite · auth-referrals-sqlite ·
doc-migration · erasure · ai-eval · claude-degrade · webhook-verify · diag · admin-guard ·
denial-of-wallet · generate-output-guard.  → `npm audit`: **0 vulnerabilities**.

## B. Live API adversarial battery — 16/16 PASS (`evidence/adversarial-run.txt`)
| ID | Test | Result |
|---|---|---|
| A1 | admin credit without / wrong key | **403 / 403** PASS |
| H1 | read account wallet w/o token (session binding on) | **403** PASS |
| H1 | spend account wallet w/o token | **403** PASS |
| H1 | read A's wallet with B's session | **403** PASS |
| H1 | owner reads own wallet with session | **200, 500 paid** PASS |
| V1 | malformed JSON body | **400 invalid_json** PASS |
| V2 | oversized body (>2 MB) | **rejected** PASS (socket closed at cap — see D-01) |
| W1 | Stripe webhook bad signature | **400** PASS |
| W2 | Stripe webhook valid | **credited 500** PASS |
| W3 | Stripe webhook replay | **idempotent (replayed:true)** PASS |
| S1 | security headers (HSTS/nosniff/frame/referrer/CSP) | **present** PASS |
| S2 | CORS wildcard, no allow-credentials | **safe** PASS |
| P1 | `/v1/media?f=../../../../etc/passwd` | **403 blocked** PASS |
| R1 | 135 rapid requests | **429 after ~120/min** PASS |

## C. Live financial integrity — 4/4 PASS (`evidence/financial-run.txt`)
| Test | Result |
|---|---|
| TOCTOU: 12 concurrent charges vs 3-ACU wallet | **exactly 3 succeed, 9 refused (402)** PASS |
| No free rides (ok+refused=12) | PASS |
| Balance never negative, reconciles to (3−ok) | **bal=0** PASS |
| Ledger records entries for credit+debits | PASS (exact reconciliation also in money-leaks F3) |

## D. Browser critical journey — 9/9 PASS, mobile 390px + slow-3G (`evidence/walkthrough-run.txt`, shots 01–04)
| Journey | Result |
|---|---|
| J1 free score renders number + verdict (no account) | **"6.3 CONDITIONAL GO"** PASS |
| J1 no JS errors on landing | PASS |
| J2 signup creates session (PoW solved in real browser) | PASS |
| J2 no JS errors during signup | PASS |
| J3a wallet synced credited balance | **paid=500** PASS |
| J3 full search renders ranked niche cards | **3 cards (scores, pillars, financials)** PASS |
| J3 no JS errors during search | PASS |
| J4 dashboard loads clean | PASS |

## E. NOT TESTED here (no access/keys) — all land in `human-actions.md`
Real-model AI quality/injection (no live key — plumbing + fallback + output-guard tested
on mock); live Stripe/KODA settlement; real email/SMS delivery; production load/soak at
scale; production deploy→smoke→rollback drill on the live box; cross-browser matrix
(Safari/Firefox real devices); accessibility screen-reader pass (WCAG 2.2 AA) — not run.
