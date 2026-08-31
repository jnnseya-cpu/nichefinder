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
HOOK="${NF_ALERT_WEBHOOK:-}"
stamp() { date -u +%FT%TZ; }
alert() { # $1 = message — best-effort Slack/Discord/Teams notify
  echo "$(stamp) $1"
  [ -n "$HOOK" ] && curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    --data "$(printf '{"text":"%s"}' "$(echo "$1" | sed 's/"/\\"/g')")" "$HOOK" >/dev/null 2>&1 || true
}

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

# Gate 1 — TESTS (pre-restart): never restart a broken build. Tests use MOCK_AI
# and their own ports. HERMETIC: every store points at a throwaway dir and any
# inherited encryption key is dropped, so the suite can never read or write the
# LIVE data/ files (auth, wallets, referrals) — a test without its own store
# path would otherwise fall back to the repo's real data dir.
TDATA="$(mktemp -d)"
if ! ( cd backend/gateway && env -u WALLET_STORE_KEY \
        WALLET_STORE="$TDATA/wallets.json" AUTH_STORE="$TDATA/auth.json" REFERRALS_STORE="$TDATA/referrals.json" \
        DOCS_STORE="$TDATA/docs.json" ARTICLES_STORE="$TDATA/articles.json" LEADS_STORE="$TDATA/leads.jsonl" \
        AVATAR_STORE="$TDATA/avatars" WALLET_DB="$TDATA/wallets.db" AUTH_DB="$TDATA/auth.db" REFERRALS_DB="$TDATA/referrals.db" \
        npm test ) >"$TESTLOG" 2>&1; then
  rm -rf "$TDATA"
  git reset -q --hard "$LOCAL"   # roll the working tree back; live service untouched
  alert "🔴 Niche Finder deploy BLOCKED: tests failed for ${REMOTE:0:8} — kept ${LOCAL:0:8} live (see $TESTLOG)"
  exit 1
fi
rm -rf "$TDATA"

# Restart onto the new code.
systemctl restart "$SERVICE"

# Gate 2 — SMOKE (post-restart): unit tests can pass while the LIVE service is
# broken (bad env, crash-loop, a runtime-only regression). Probe the real running
# service; if it doesn't come up healthy, AUTO-ROLL-BACK to the last good commit,
# restart, and confirm recovery — a bad push can never stay live.
if bash scripts/nf-smoke.sh; then
  alert "✅ Niche Finder DEPLOYED ${REMOTE:0:8} — tests + live smoke passed."
  exit 0
fi

echo "$(stamp) SMOKE FAILED for $REMOTE — rolling back to $LOCAL" >&2
git reset -q --hard "$LOCAL"
# If the lockfile had changed forward, restore the previous deps too.
if ! git diff --quiet "$REMOTE" "$LOCAL" -- backend/gateway/package-lock.json; then
  ( cd backend/gateway && npm ci --omit=dev ) || true
fi
systemctl restart "$SERVICE"
if bash scripts/nf-smoke.sh; then
  alert "↩️ Niche Finder AUTO-ROLLED-BACK to ${LOCAL:0:8}: new commit ${REMOTE:0:8} failed its live smoke test. Service healthy on the previous version — investigate before re-pushing."
else
  alert "🆘 Niche Finder DOWN: commit ${REMOTE:0:8} failed smoke AND the rollback to ${LOCAL:0:8} did not come up healthy. MANUAL INTERVENTION NEEDED NOW."
fi
exit 1
