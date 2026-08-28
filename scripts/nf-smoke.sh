#!/usr/bin/env bash
# Niche Finder — post-deploy SMOKE check. Unit tests run under MOCK_AI on their
# own ports, so they pass even when the freshly-restarted LIVE service is broken
# (bad env, crash-loop, a route that 500s, a runtime-only regression). This hits
# the REAL running service and confirms it actually serves before a deploy is
# considered good. Exit 0 = healthy, non-zero = roll back.
#
# Env:
#   NF_SMOKE_URL      health URL to probe (default http://localhost:8080/v1/health)
#   NF_SMOKE_RETRIES  attempts while the service boots (default 6)
#   NF_SMOKE_DELAY    seconds between attempts (default 3)
#   NF_SMOKE_STRICT   1 = require status:ok (reject maintenance); default accepts
#                     any valid health JSON (the app booted and serves).
set -uo pipefail

URL="${NF_SMOKE_URL:-http://localhost:8080/v1/health}"
RETRIES="${NF_SMOKE_RETRIES:-6}"
DELAY="${NF_SMOKE_DELAY:-3}"
STRICT="${NF_SMOKE_STRICT:-0}"
log() { echo "[nf-smoke] $*"; }

i=0
while [ "$i" -lt "$RETRIES" ]; do
  i=$((i+1))
  CODE="$(curl -sS -o /tmp/nf-smoke.$$ -w '%{http_code}' -m 10 "$URL" 2>/dev/null || echo 000)"
  BODY="$(cat /tmp/nf-smoke.$$ 2>/dev/null || true)"; rm -f /tmp/nf-smoke.$$
  if [ "$CODE" = "200" ] && echo "$BODY" | grep -q '"status"'; then
    if [ "$STRICT" = "1" ] && ! echo "$BODY" | grep -q '"status":"ok"'; then
      log "attempt $i/$RETRIES: 200 but not status:ok (strict) — $BODY"
    else
      log "OK — $URL healthy ($BODY)"; exit 0
    fi
  else
    log "attempt $i/$RETRIES: HTTP $CODE $( [ "$CODE" = 000 ] && echo '(no response — booting/down)')"
  fi
  [ "$i" -lt "$RETRIES" ] && sleep "$DELAY"
done
log "FAIL — $URL did not become healthy after $RETRIES attempts"
exit 1
