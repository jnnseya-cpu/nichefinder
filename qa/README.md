# Niche Finder OS — end-to-end QA harness

`e2e.js` drives the whole OS in a real browser (playwright-core + system Chromium)
as a **user** and as an **admin**, plus live HTTP tests against the backend gateway.
38 checks, one screenshot per passing test.

## Run

```bash
# 1. serve the frontend from the repo root
python3 -m http.server 8901

# 2. start the gateway in mock mode with an encrypted store
cd backend/gateway
MOCK_AI=1 WALLET_STORE_KEY=<64-hex-chars> WALLET_STORE=/tmp/qa-wallets.json PORT=8902 node src/server.js

# 3. run the suite
npm install playwright-core
node qa/e2e.js       # exits 0 only when every check passes
```

Coverage: consent, welcome wallet, top-up packages, subscription plans, mandatory
country, live capital-bracket pricing, Investor Mode, discovery charge + results,
search history, unlock, Build Hub engines, document viewer, support concierge,
low-balance alert, human-only bot blocking, admin KPIs, ACU grants, blog
publish-to-live loop, support case resolution, SEO/governance/ledger panes, comms
engine send-test, bot-block events, Government Mode datasets, and the gateway API
(health, bracketed generation, wallet credit/charge/idempotency/402+4001,
transactions, encrypted store, smoke suite).
