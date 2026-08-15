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
# persistent stores (survive restarts)
WALLET_STORE=/opt/nichefinder/backend/gateway/data/wallets.json
LEADS_STORE=/opt/nichefinder/backend/gateway/data/leads.jsonl
```
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
