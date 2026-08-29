#!/usr/bin/env bash
# Niche Finder — file → SQLite cutover. Runs the whole runbook safely: checks
# Node 22, backs up, freezes writes, migrates + VERIFIES all three stores
# (wallets, auth, referrals), then either prints the flag to flip (default) or —
# with NF_AUTO_FLIP=1 — flips it, restarts, smoke-tests, and AUTO-ROLLS-BACK to
# the file backend if the live service isn't healthy. Migrations never mutate the
# JSON, so the file backend is always the instant rollback.
set -euo pipefail
REPO="${NF_REPO:-/opt/nichefinder}"
ENV_FILE="${NF_ENV_FILE:-/etc/nichefinder.env}"
SERVICE="${NF_SERVICE:-nichefinder}"
DATA="${NF_DATA_DIR:-$REPO/backend/gateway/data}"
log() { echo "[cutover $(date -u +%H:%M:%SZ)] $*"; }

[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }   # WALLET_STORE_KEY + paths for the migration tools

# 1. Node >= 22 (node:sqlite is built in there).
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "ABORT: Node $NODE_MAJOR < 22 — node:sqlite needs 22. Upgrade first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
log "Node $(node -v) OK"
cd "$REPO"
[ -d "$DATA" ] || { log "ABORT: data dir not found: $DATA"; exit 1; }

# 2. Backup before touching anything.
if [ -x scripts/nf-backup.sh ]; then
  NF_DATA_DIR="$DATA" bash scripts/nf-backup.sh || log "WARN: backup failed — continuing (migration never mutates the JSON source)"
fi

# 3. Freeze writes.
log "stopping $SERVICE"; systemctl stop "$SERVICE" || true

# 4. Migrate + verify each store. Any failure → restart on the old backend, abort.
migrate() { # name tool args...
  local name="$1"; shift
  log "migrating $name"
  if ! node "$@"; then log "ABORT: migration failed for $name"; systemctl start "$SERVICE" || true; exit 1; fi
}
[ -f "$DATA/wallets.json" ]   && migrate wallets   scripts/nf-migrate-store.mjs    "$DATA/wallets.json"   "$DATA/money.db"
[ -f "$DATA/auth.json" ]      && migrate auth      scripts/nf-migrate-docstore.mjs "$DATA/auth.json"      "$DATA/auth.db"      users,sessions
[ -f "$DATA/referrals.json" ] && migrate referrals scripts/nf-migrate-docstore.mjs "$DATA/referrals.json" "$DATA/referrals.db" codes,byCode,links,earned,awarded,awardAmount,reversed
log "ALL MIGRATIONS VERIFIED."

FLAGS="STORE_BACKEND=sqlite
WALLET_DB=$DATA/money.db
AUTH_DB=$DATA/auth.db
REFERRALS_DB=$DATA/referrals.db"

strip() { grep -vE '^(STORE_BACKEND|WALLET_DB|AUTH_DB|REFERRALS_DB)=' "$ENV_FILE"; }

if [ "${NF_AUTO_FLIP:-0}" = "1" ]; then
  log "flipping $ENV_FILE to sqlite and restarting"
  cp "$ENV_FILE" "$ENV_FILE.pre-sqlite.$(date -u +%s)"
  { strip || true; echo "$FLAGS"; } > "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE"
  systemctl start "$SERVICE"; sleep 3
  if bash scripts/nf-smoke.sh; then
    log "SUCCESS — live on SQLite, smoke passed. Keep the JSON files until you're confident (they are the rollback)."
  else
    log "SMOKE FAILED on sqlite — ROLLING BACK to the file backend"
    { strip || true; } > "$ENV_FILE.new" && mv "$ENV_FILE.new" "$ENV_FILE"
    systemctl restart "$SERVICE"; sleep 3
    bash scripts/nf-smoke.sh && log "rolled back to file backend — healthy." || log "ROLLBACK ALSO UNHEALTHY — investigate now."
    exit 1
  fi
else
  systemctl start "$SERVICE"   # comes back on the current (file) backend; DBs sit ready
  log "Migration complete + verified — service restarted on the CURRENT backend."
  log "To go live on SQLite, add these to $ENV_FILE and restart the service:"
  echo "----"; echo "$FLAGS"; echo "----"
  log "Or re-run as:  sudo NF_AUTO_FLIP=1 $0   (flips + smokes + auto-rolls-back on failure)"
fi
