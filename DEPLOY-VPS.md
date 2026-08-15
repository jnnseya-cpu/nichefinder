# Deploy Niche Finder on a Hostinger VPS (no new vendors)

The whole OS runs as **one Node process** on your VPS: it serves the frontend,
the shared modules, and the `/v1` API. Caddy sits in front for automatic HTTPS
(Let's Encrypt). Your Hostinger domain points at the VPS. Firebase/Vercel are
not needed for launch.

Prerequisites on the VPS: Ubuntu/Debian, root or sudo, ports 80 + 443 open, and
your domain's DNS **A record** pointing at the VPS IP (set in Hostinger → DNS).

---

## 1. Install Node 20 + Caddy (one time)

```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy (auto-HTTPS reverse proxy)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 2. Get the code and install dependencies

```bash
sudo git clone https://github.com/jnnseya-cpu/nichefinder.git /opt/nichefinder
cd /opt/nichefinder
sudo git checkout claude/niche-finder-overview-mj1rmw
cd backend/gateway
sudo npm ci --omit=dev
```
The full repo must be present (frontend/ and shared/ sit next to backend/gateway/ —
the gateway serves them by relative path).

## 3. Create the secrets file (never in the repo)

```bash
sudo nano /etc/nichefinder.env
```
Paste, filling in your own values:
```
PORT=8080
NODE_ENV=production
PUBLIC_ORIGIN=https://app.yourdomain.com
ANTHROPIC_API_KEY=sk-ant-...
# optional failover
GEMINI_API_KEY=
OPENAI_API_KEY=
# payments — start with sk_test_ / whsec_ from Stripe test mode
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
# money data encryption at rest — MUST be exactly 64 hex chars:
#   run:  openssl rand -hex 32
WALLET_STORE_KEY=REPLACE_WITH_64_HEX
# admin/support credit path — any long random string:
#   run:  openssl rand -hex 24
ADMIN_API_KEY=REPLACE_WITH_RANDOM
# admin ACCOUNT (seeds the operator login for /admin-console.html on first boot).
# The account is created with this email+password if it doesn't exist; an
# account signing up with ADMIN_EMAIL is also granted the admin role.
ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=REPLACE_WITH_A_STRONG_PASSWORD
# email (operator's own mail host — e.g. Hostinger; no new vendor). Powers
# password-reset emails and contact-form notifications. Implicit TLS on 465.
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=contact@nichefinderhq.com
SMTP_PASS=REPLACE_WITH_MAILBOX_PASSWORD
SMTP_FROM=Niche Finder <contact@nichefinderhq.com>
# where contact-form submissions are emailed (defaults to SMTP_USER)
CONTACT_INBOX=contact@nichefinderhq.com
# persistent stores (survive restarts)
WALLET_STORE=/opt/nichefinder/backend/gateway/data/wallets.json
AUTH_STORE=/opt/nichefinder/backend/gateway/data/auth.json
LEADS_STORE=/opt/nichefinder/backend/gateway/data/leads.jsonl
```
The admin login has no mailbox, so `ADMIN_PASSWORD` in this file is the admin
password and its recovery path: change it and restart to reset the admin login.
```bash
sudo chmod 600 /etc/nichefinder.env   # readable only by root
sudo mkdir -p /opt/nichefinder/backend/gateway/data
```

## 4. Run it as a service (systemd — auto-restart, survives reboot)

```bash
sudo nano /etc/systemd/system/nichefinder.service
```
```ini
[Unit]
Description=Niche Finder OS gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/nichefinder/backend/gateway
EnvironmentFile=/etc/nichefinder.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
# harden a little
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nichefinder
sudo systemctl status nichefinder      # should be "active (running)"
curl -s localhost:8080/v1/health        # {"status":"ok",...}
```

## 5. Put HTTPS in front (Caddy — automatic Let's Encrypt cert)

```bash
sudo nano /etc/caddy/Caddyfile
```
```
app.yourdomain.com {
    reverse_proxy localhost:8080
    encode gzip
}
```
```bash
sudo systemctl reload caddy
```
Caddy fetches a TLS certificate automatically once DNS points at the VPS. Your
site is now live at `https://app.yourdomain.com`.

## 6. Point the front end at itself

Since the gateway serves the frontend, its API is same-origin — set the switch
so the browser uses it:
```bash
sudo nano /opt/nichefinder/frontend/nf-config.js
# set:  window.NF_GATEWAY_URL = 'https://app.yourdomain.com';
sudo systemctl restart nichefinder
```

## 7. Stripe webhook + rehearsal (test keys first)

- Stripe → Developers → Webhooks → add `https://app.yourdomain.com/v1/payments/stripe-webhook`, event `checkout.session.completed`. Put the `whsec_` into `/etc/nichefinder.env`, then `sudo systemctl restart nichefinder`.
- Open the site → free niche score → one real search → Buy ACU → Stripe test card `4242 4242 4242 4242` → confirm ACUs land. That proves checkout → webhook → credit.

## 8. Go live

Swap `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` in `/etc/nichefinder.env` to the
live `sk_live_`/`whsec_` values, `sudo systemctl restart nichefinder`, and buy the
£5 Starter yourself with a real card. Money settles to your Stripe balance → your
bank.

---

## Updating later
```bash
cd /opt/nichefinder && sudo git pull
cd backend/gateway && sudo npm ci --omit=dev
sudo systemctl restart nichefinder
```

## Health & logs
```bash
sudo journalctl -u nichefinder -f      # live gateway logs
sudo systemctl restart nichefinder     # restart
curl -s https://app.yourdomain.com/v1/health
```

## Optional: frontend on Vercel instead
If you prefer Vercel's CDN for the static pages: deploy the `frontend/` +
`shared/` folders to Vercel, and set `window.NF_GATEWAY_URL` in `nf-config.js`
to your VPS API origin (`https://app.yourdomain.com`). The gateway already sends
permissive CORS headers, so cross-origin calls work. This adds a second thing to
manage; serving the frontend from the VPS (default above) is simpler and needs
no extra step.

---

## Automatic deployment (self-hosted, no new vendor)

A systemd timer on the VPS polls the deploy branch every ~2 minutes; on a new
commit it fast-forwards, installs deps only if the lockfile changed, runs the
full test suite, and restarts the gateway **only if tests pass** (a failed build
keeps the current version live). No GitHub secrets, no inbound ports, no external
CI. The gateway injects `PUBLIC_ORIGIN` into `nf-config.js` at serve time, so the
committed file is never edited on the box and pulls never conflict.

**One-time setup on the VPS:**
```bash
# 1. Ensure PUBLIC_ORIGIN is set in /etc/nichefinder.env (e.g. https://nichefinderhq.com)
#    and remove any manual edit to the tracked config so pulls stay clean:
cd /opt/nichefinder
sudo git checkout -- frontend/nf-config.js
sudo git pull origin claude/niche-finder-overview-mj1rmw   # get the auto-deploy scripts

# 2. Install the systemd units and enable the timer:
sudo cp scripts/nf-deploy.service /etc/systemd/system/
sudo cp scripts/nf-deploy.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nf-deploy.timer
```

**Watch / manage it:**
```bash
systemctl status nf-deploy.timer          # next scheduled run
sudo systemctl start nf-deploy.service     # deploy right now (don't wait for the timer)
journalctl -u nf-deploy.service -f         # live deploy log
cat /var/log/nf-deploy-test.log            # test output from the last deploy
```
From now on, every push to the deploy branch goes live automatically within a
couple of minutes — only if it's green.
