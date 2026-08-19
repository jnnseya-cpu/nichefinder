# SATURDAY GO-LIVE — the one page to follow

> **Hosting: Hostinger VPS.** The deploy mechanics (install, systemd, HTTPS,
> secrets) live in **`DEPLOY-VPS.md`** — follow that for the server setup. The
> rehearsal + go-live discipline below (test keys first, be customer zero)
> still applies exactly.

Everything in the code is done and green (smoke 45/45, full payment cycle passed).
Saturday is **founder admin + one deploy**, in this exact order. Budget ~90 min.
Do NOT skip step 6 (test-key rehearsal) — it is the difference between a launch
and a refund queue.

## Before Saturday (do now if you can)
- [ ] Stripe account created, business details + bank account added (approval can take a day — start early)
- [ ] Anthropic account + API key, £50–100 credit loaded
- [ ] Hostinger VPS ready: Node 20 + Caddy installed (DEPLOY-VPS.md §1) and your domain's DNS **A record** pointing at the VPS IP
- [ ] Domain available to point (e.g. app.nichefinderhq.com)

## Saturday sequence

**1. Deploy (15 min).** Follow **DEPLOY-VPS.md** §1–§5: clone the repo to
`/opt/nichefinder`, check out this branch, `npm ci --omit=dev` in `backend/gateway`,
then install the systemd service + Caddy site. One Node process serves the
frontend, `/shared`, and the `/v1` API.

**2. Paste secrets (5 min)** into `/etc/nichefinder.env` on the VPS (never in the repo):
- `ANTHROPIC_API_KEY` = your key
- `STRIPE_SECRET_KEY` = `sk_test_…` (test first!)
- `STRIPE_WEBHOOK_SECRET` = from step 4
- `PUBLIC_ORIGIN` = your final https URL
- `WALLET_STORE_KEY` = `openssl rand -hex 32`, `ADMIN_API_KEY` = `openssl rand -hex 24` (generate once, keep them stable)

**3. First boot check (2 min).** Open `https://<host>/v1/health`. You want
`"status":"ok"` and your provider listed. (`"payments":false` is fine until step 4.)

**4. Stripe webhook (5 min).** Stripe Dashboard → Developers → Webhooks → Add
endpoint `https://<host>/v1/payments/stripe-webhook`, event
`checkout.session.completed`. Copy the `whsec_…` into `STRIPE_WEBHOOK_SECRET`
(step 2), redeploy. `/v1/health` should now show `"payments":true`.

**5. Point the domain + wire the front end (15 min).** DNS → your host. Then set
`window.NF_GATEWAY_URL` in `frontend/nf-config.js` to your https origin, commit,
redeploy (one line).

**6. REHEARSE ON TEST KEYS (15 min) — do not skip.**
- Open the site, run the **free Niche Score** on the homepage (no signup) → confirm instant result
- Go to Search Canvas → run one real search (spends welcome credits or paid)
- Click **Buy ACU**, pay with Stripe test card `4242 4242 4242 4242`, any future expiry/CVC
- Confirm ACUs land in the wallet (that proves checkout → webhook → credit end-to-end)
- Confirm the money shows in your Stripe **test** dashboard

**7. GO LIVE (10 min).** Swap `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to
the **live** `sk_live_…` / `whsec_…`, redeploy. Buy the £5 Starter yourself as
customer zero with a real card. Money hits your Stripe balance → your bank on the
payout schedule.

**8. Turn on the funnel (5 min).** Admin OS → SEO War Room → **Start Autopilot**
(publishes articles). Post the homepage free-score link once with your own scored
idea. You are live and acquiring.

## Verify readiness any time
Run `node scripts/preflight.mjs` from the repo root — it checks deploy files,
runs the test suites, and prints a GO / NO-GO.

## If something breaks Saturday
- **`/v1/health` won't load** → deploy failed; check `sudo journalctl -u nichefinder -n 50` for a missing env var.
- **Payment doesn't credit ACUs** → webhook secret wrong or endpoint URL typo; re-check step 4. The money is still safe in Stripe; no ACUs are lost.
- **Generation says 402 / insufficient** → correct behaviour with an empty paid balance; buy a package first. This is the no-free-AI law working.
- **Anything worse** → the encrypted wallet store and Stripe are the source of truth; a redeploy never loses money or balances. Roll back on the VPS: `cd /opt/nichefinder && sudo git checkout <previous-good-commit> && sudo systemctl restart nichefinder` (data/ is untouched by a code rollback).

## The rule for the day
Test keys before live keys. Free score works before you promote it. One real £5
purchase by you before you tell anyone. Then open the doors.
