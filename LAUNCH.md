# NICHE FINDER — LAUNCH RUNBOOK

The honest state of the OS, what can go in front of the general public tomorrow,
and every blocker with its fix. Updated after the 38/38 QA campaign and the
revenue-rail build (Stripe Checkout + webhook settlement).

---

## What the codebase can do TODAY (all tested)

One deploy of `backend/gateway` now serves the **entire OS**: the frontend at
`/`, the shared economy at `/shared/`, and the API at `/v1/`. It includes:

- Real AI generation with claude → gemini → openai failover (needs provider keys)
- Server-side ACU wallet: welcome grant, idempotent charge/credit, 402 enforcement,
  AES-256-GCM encrypted store, capital-bracket metering on every request
- **Real payments**: `POST /v1/payments/checkout` creates a hosted Stripe Checkout
  session priced from the canonical package table; the settlement webhook
  (`/v1/payments/stripe-webhook`, HMAC-verified, replay-protected) credits ACUs
  exactly once per Stripe event. Client never sets prices, never credits itself
  when payments are live.
- Lead/waitlist capture (`POST /v1/leads`, honeypot + validation, JSONL store)
- Per-IP rate limiting, CORS, path-traversal-safe static hosting
- 27-check smoke suite + 38-check browser QA harness (`qa/e2e.js`)

## ⚡ GO-LIVE MORNING CHECKLIST (final — everything below is already tested)

The code side is DONE and proven tonight: 38/38 browser QA, 35-check backend
smoke, and a **15-check FULL PAYMENT CYCLE test** (checkout → signed settlement
webhook → exactly-once credit → server-metered generation debit → overdraft
refusal → self-credit lockout → encrypted store). Production billing enforcement
turns itself on the moment Stripe keys are present:

- The SERVER meters and debits every generation — clients can never bill themselves
- Client-side crediting is disabled — ACUs enter only via Stripe settlement (or the ADMIN_API_KEY support path)
- Anonymous and guessable wallet ids are refused (capability-grade ids, ~130-bit entropy)
- Admin cockpits are hidden from the public deploy unless EXPOSE_ADMIN=1

Morning sequence (60–90 min of founder admin, in order):

1. **Stripe**: create account → copy `sk_live_` → add webhook endpoint
   `https://<host>/v1/payments/stripe-webhook` (event: `checkout.session.completed`) → copy `whsec_`
2. **Anthropic**: create API key, load £50–100 credit (Gemini/OpenAI optional failover)
3. **Deploy**: on your Hostinger VPS, follow **DEPLOY-VPS.md** (Node 20 + Caddy,
   clone to `/opt/nichefinder`, `npm ci --omit=dev`, systemd service) — put the
   secrets in `/etc/nichefinder.env`; generate `WALLET_STORE_KEY`/`ADMIN_API_KEY`
   with `openssl rand -hex 32` / `-hex 24`
4. **Domain**: point DNS at the service; set `PUBLIC_ORIGIN`; set `window.NF_GATEWAY_URL`
   in `frontend/nf-config.js` to the same origin; redeploy (one commit)
5. **Rehearse with test keys first**: `sk_test_` + card 4242 4242 4242 4242 → watch ACUs land
   → run one real search → THEN swap to live keys
6. **Verify live**: `/v1/health` shows `"payments": true` and your providers; buy the £5 Starter
   yourself as customer zero

## LAUNCH TOMORROW — Day-1 runbook (≈ half a day of founder work)

| # | Step | Owner | Time |
|---|---|---|---|
| 1 | Create Stripe account (business details + bank account for payouts) | Founder | 1–2 h (approval usually same-day) |
| 2 | Buy provider API credit: Anthropic (required), Google/OpenAI (optional failover) | Founder | 15 min |
| 3 | Deploy on the Hostinger VPS per **DEPLOY-VPS.md** (Node 20 + Caddy, systemd `nichefinder` service) with env in `/etc/nichefinder.env`: `ANTHROPIC_API_KEY`, `WALLET_STORE_KEY` (64 hex), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_ORIGIN`; `data/` lives on the VPS disk | Founder (or hand me the server) | 30 min |
| 4 | In Stripe: add webhook endpoint `https://<host>/v1/payments/stripe-webhook`, event `checkout.session.completed`; copy `whsec_` into env | Founder | 5 min |
| 5 | Point a domain (e.g. app.nichefinderhq.com) at the deploy; set `window.NF_GATEWAY_URL` in `frontend/nf-config.js` to that origin; redeploy | Founder | 15 min |
| 6 | Test-mode dry run (sk_test keys): buy Starter £5 with card 4242…, watch ACUs land via webhook; then flip to live keys | Founder | 20 min |

**After step 6, a member of the public can pay £5–£50 by card, the money settles
to your Stripe balance (→ your bank on the payout schedule), and their paid ACUs
fund real AI discovery runs and documents.** That is money in the bank and value
in the user's hands.

## What to SOFT-LAUNCH as (recommendation)

Launch as a **paid public beta**: marketing pages + live Search Canvas + top-ups
+ document engines, with the wallet keyed per-browser (current design) and a
visible "beta — account sync coming" notice. Collect every visitor into
`/v1/leads`. This is honest, chargeable, and shippable tomorrow.

## VENDOR POLICY — no new vendors

The only external vendors the OS uses are the ones already committed: **the AI
providers** (Anthropic required; Google/OpenAI optional failover), **Stripe**
(payments), and **your chosen host** (one Node service). Everything else —
human verification, anti-hacking, auth, sessions, the wallet store — is built
in-house on the gateway with Node's standard library and the encrypted file
store. No Firebase, no Supabase, no Cloudflare Turnstile, no Resend/SendGrid.
The blocker fixes below all honour that.

## BLOCKERS for a full (non-beta) public launch — and the in-house fixes

| Severity | Blocker | Why it matters | In-house fix (no new vendor) | Est. |
|---|---|---|---|---|
| 🔴 | **No real accounts** — wallet is keyed to a per-browser id | Clear cookies = lose balance; can't use two devices; welcome-ACU farming | Build email+password auth **inside the gateway**: bcrypt-style hashing via Node `crypto.scrypt`, accounts in the existing AES-256-GCM encrypted store, signed session tokens (HMAC), `NF_WALLET_USER` bound to the account id. Gate signup with the in-house human challenge (`NF_verifyHuman`). Zero third parties. | 2–3 days dev |
| 🔴 | **Business & legal reality** — Stripe needs a legal entity + bank account; Terms/Privacy reviewed for your jurisdictions | Payments and refunds are regulated | Register the company (or use existing), open business bank account, solicitor pass over Terms/Privacy/refund policy | Founder, days |
| 🟠 | **AI quality pass at scale** — prompts tested but not tuned against volume with fresh keys | Public output quality = the brand | Once keys are live, structured evals on 20–30 real searches across countries; tune prompts | 1 day |
| 🟠 | **File-store wallet on one instance** — fine for a single-instance beta, races if scaled horizontally | Two instances would race the store | Stay single-instance for beta (no new vendor). When scale demands it, run Postgres **on the same VPS** (or Hostinger's managed database) — no new vendor; schema already specified | 2–3 days dev when needed |
| 🟠 | **Refund/chargeback ops** — webhook credits, but reversals are manual | Disputes will happen | Add `charge.refunded`/`dispute` handlers to the **existing Stripe webhook** issuing compensating debits + written refund policy | ½ day dev |
| 🟢 | **Human verification (CAPTCHA)** — DONE in-house | Human-only law, production grade | ✅ Proof-of-work challenge on the gateway (`/v1/human/*`) + browser solver (`NF_verifyHuman`); no Turnstile/reCAPTCHA. Stacks with honeypot, submission-timing, and the Sentinel agent | shipped |
| 🟢 | **Anti-hacking + non-human instruction blocking** — DONE in-house | Attack + prompt-injection defence | ✅ Sentinel agent screens every request, blocks injection before provider calls, strike-bans abusers | shipped |
| 🟡 | **Transactional email** (receipts, password resets, alerts) | Trust + auth dependency | Use the founder's **existing** business email over SMTP (Node `nodemailer`-style, no new SaaS), or run beta on in-app Comms-Engine notifications only. No Resend/SendGrid onboarding | ½ day dev |
| 🟢 | **Admin cockpit exposure** — DONE | Anyone could open the cockpit | ✅ `admin.html`/`comms.html` return 404 on public deploys unless `EXPOSE_ADMIN=1` | shipped |
| ⚪ | Government Mode data pipeline, BitriPay/mobile money, subscriptions billing, PWA store wrap | Post-launch roadmap (P1–P2), not launch blockers | Per the transformation spec | weeks |

## The one-sentence answer

**Tomorrow you can be live and taking money as a paid public beta** on three
vendors only (AI provider + Stripe + one host); human verification,
anti-hacking, and admin lockdown already ship in-house. **A full consumer
launch needs ~1 week more** — in-house accounts/auth, refund handlers, and
SMTP over your existing email — plus the legal/banking items only a founder
can do. No new vendor is introduced at any stage.
