#!/usr/bin/env bash
# Niche Finder — ONE-TIME bootstrap deploy + enable auto-deploy.
#
# Run this once on the VPS (as root) to:
#   1. pull the deploy branch and restart the gateway (gets the current fix live), and
#   2. install + enable the nf-deploy.timer so every future push deploys itself.
#
# After this, you never deploy by hand again — pushing to the branch is enough.
#
# Usage on the server:
#   cd <repo>            # e.g. /opt/nichefinder
#   sudo bash scripts/nf-first-deploy.sh
#
# It auto-detects the repo path from the running service, and runs the full test
# suite (on mocks, separate ports — no live money, no downtime) before restarting.
set -euo pipefail

BR="${NF_DEPLOY_BRANCH:-claude/niche-finder-overview-mj1rmw}"
SERVICE="${NF_SERVICE:-nichefinder}"

# Resolve the repo dir: prefer the service's WorkingDirectory, else this script's
# own location, else the documented default.
NF_DIR="$(systemctl show -p WorkingDirectory --value "$SERVICE" 2>/dev/null || true)"
if [ -z "$NF_DIR" ] || [ ! -d "$NF_DIR/.git" ]; then
  NF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
[ -d "$NF_DIR/.git" ] || { echo "!! could not find the repo (tried '$NF_DIR'). Run from inside the checkout."; exit 1; }
echo ">> repo:    $NF_DIR"
echo ">> branch:  $BR"
echo ">> service: $SERVICE"
cd "$NF_DIR"

echo ">> [1/4] fetching + fast-forwarding the branch"
git fetch origin "$BR"
git checkout "$BR"
git merge --ff-only "origin/$BR"

echo ">> [2/4] installing deps + running the test suite (mocks, no live impact)"
# HERMETIC test run: point every store at a throwaway dir and drop any inherited
# encryption key, so the suite can never read or write the LIVE data files under
# the repo's data/ directory. Tests that need their own store/key set them and
# win over these defaults.
TDATA="$(mktemp -d)"; trap 'rm -rf "$TDATA"' EXIT
(
  cd backend/gateway && npm ci --omit=dev
  env -u WALLET_STORE_KEY \
    WALLET_STORE="$TDATA/wallets.json" AUTH_STORE="$TDATA/auth.json" REFERRALS_STORE="$TDATA/referrals.json" \
    DOCS_STORE="$TDATA/docs.json" ARTICLES_STORE="$TDATA/articles.json" LEADS_STORE="$TDATA/leads.jsonl" \
    AVATAR_STORE="$TDATA/avatars" WALLET_DB="$TDATA/wallets.db" AUTH_DB="$TDATA/auth.db" REFERRALS_DB="$TDATA/referrals.db" \
    npm test
)

echo ">> [3/4] restarting the gateway onto the new code"
systemctl restart "$SERVICE"

echo ">> [4/4] enabling auto-deploy so future pushes go live by themselves"
cp scripts/nf-deploy.service /etc/systemd/system/nf-deploy.service
cp scripts/nf-deploy.timer   /etc/systemd/system/nf-deploy.timer
systemctl daemon-reload
systemctl enable --now nf-deploy.timer

echo ""
echo ">> DONE. The fix is live and auto-deploy is on."
echo ">> Verify:  https://nichefinderhq.com/v1/admin/diag?key=\$ADMIN_API_KEY"
echo ">>          (expect 'ready' with a provider key true; then run a real search)"
