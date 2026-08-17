#!/usr/bin/env bash
# Niche Finder — VPS auto-deploy (no new vendors).
# Polls the deploy branch on GitHub; when a new commit appears it fast-forwards,
# installs deps only if the lockfile changed, runs the full test suite, and
# restarts the gateway ONLY if the tests pass. A failed build keeps the current
# version live and exits non-zero. Invoked by nf-deploy.timer (runs as root).
#
# One-time setup (see the "Automatic deployment" section of DEPLOY-VPS.md):
#   sudo cp scripts/vps-autodeploy.sh /opt/nichefinder/scripts/  # already in repo
#   sudo systemctl enable --now nf-deploy.timer
set -euo pipefail

REPO="${NF_REPO:-/opt/nichefinder}"
BRANCH="${NF_DEPLOY_BRANCH:-claude/niche-finder-overview-mj1rmw}"
SERVICE="${NF_SERVICE:-nichefinder}"
TESTLOG="${NF_TEST_LOG:-/var/log/nf-deploy-test.log}"
stamp() { date -u +%FT%TZ; }

cd "$REPO"

# Single-flight lock: prevent an overlapping run (e.g. the timer firing while a
# manual run is mid-deploy) from clobbering the other's working-tree state — the
# race that can otherwise leave HEAD reset onto an older commit.
exec 9>/tmp/nf-deploy.lock
flock -n 9 || { echo "$(stamp) another deploy is in progress — skipping this run"; exit 0; }

git fetch --quiet origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0   # already up to date — the common, silent path

echo "$(stamp) new commit on $BRANCH: $LOCAL -> $REMOTE"
git checkout -q "$BRANCH"
git merge --ff-only "origin/$BRANCH"   # fast-forward only; never clobber local divergence

# Install deps only when the lockfile changed (skips the slow path on most deploys).
if ! git diff --quiet "$LOCAL" "$REMOTE" -- backend/gateway/package-lock.json; then
  echo "$(stamp) lockfile changed — running npm ci"
  ( cd backend/gateway && npm ci --omit=dev )
fi

# Test gate: never restart a broken build. Tests use MOCK_AI and their own ports,
# so they neither cost money nor touch the live service.
if ( cd backend/gateway && npm test ) >"$TESTLOG" 2>&1; then
  systemctl restart "$SERVICE"
  echo "$(stamp) DEPLOYED $REMOTE — $SERVICE restarted"
else
  echo "$(stamp) TESTS FAILED for $REMOTE — kept $LOCAL live (see $TESTLOG)" >&2
  git reset -q --hard "$LOCAL"   # roll the working tree back to the last good commit
  exit 1
fi
