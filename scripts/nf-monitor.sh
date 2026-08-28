#!/usr/bin/env bash
# Niche Finder — uptime + health watchdog. Runs on a timer, checks the live
# gateway, and ALERTS on failure so an outage is caught by an alert, not by a
# customer. De-duplicated: it only notifies on a state CHANGE (up->down and the
# down->up recovery), so it never spams. Zero dependencies beyond curl.
#
# Env:
#   NF_HEALTH_URL     health endpoint (default https://nichefinderhq.com/v1/health)
#   NF_ALERT_WEBHOOK  incoming webhook URL (Slack/Discord/Teams accept {"text":...}).
#                     If unset, alerts are logged only (journald) — set this to get
#                     phone/desktop notifications.
#   NF_METRICS_URL    optional admin metrics endpoint (…/v1/admin/metrics)
#   NF_ADMIN_KEY      admin key for the metrics check (x-admin-key header)
#   NF_MONITOR_STATE  state file (default /var/lib/nichefinder/monitor.state)
#   NF_ERR_RATE_MAX   alert if 5xx-rate over the sample exceeds this % (default 20)
set -uo pipefail

URL="${NF_HEALTH_URL:-https://nichefinderhq.com/v1/health}"
HOOK="${NF_ALERT_WEBHOOK:-}"
STATE="${NF_MONITOR_STATE:-/var/lib/nichefinder/monitor.state}"
METRICS="${NF_METRICS_URL:-}"
ADMIN_KEY="${NF_ADMIN_KEY:-}"
ERR_MAX="${NF_ERR_RATE_MAX:-20}"
mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
PREV="$(cat "$STATE" 2>/dev/null || echo up)"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[nf-monitor $(now)] $*"; }

notify() { # $1 = message
  log "$1"
  [ -n "$HOOK" ] || return 0
  curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    --data "$(printf '{"text":"%s"}' "$(echo "$1" | sed 's/"/\\"/g')")" "$HOOK" >/dev/null 2>&1 || log "alert webhook POST failed"
}

# 1) Liveness + TLS + config: health must return 200 and status ok (not maintenance).
CODE="$(curl -sS -o /tmp/nf-health.$$ -w '%{http_code}' -m 15 "$URL" 2>/dev/null || echo 000)"
BODY="$(cat /tmp/nf-health.$$ 2>/dev/null || true)"; rm -f /tmp/nf-health.$$
STATUS=down; REASON=""
if [ "$CODE" = "200" ] && echo "$BODY" | grep -q '"status":"ok"'; then
  STATUS=up
elif [ "$CODE" = "000" ]; then REASON="unreachable (DNS/TLS/host down)"
elif [ "$CODE" = "200" ]; then REASON="degraded ($(echo "$BODY" | grep -o '"status":"[^"]*"' | head -1))"
else REASON="HTTP $CODE"; fi

# 2) Optional silent-failure check: error / webhook-failure spike from metrics.
DEGRADE=""
if [ "$STATUS" = "up" ] && [ -n "$METRICS" ] && [ -n "$ADMIN_KEY" ]; then
  M="$(curl -sS -m 10 -H "x-admin-key: $ADMIN_KEY" "$METRICS" 2>/dev/null || true)"
  ER="$(echo "$M" | grep -o '"errorRatePct":[0-9.]*' | grep -o '[0-9.]*' | head -1)"
  WF="$(echo "$M" | grep -o '"webhookFailures":[0-9]*' | grep -o '[0-9]*' | head -1)"
  if [ -n "$ER" ] && awk "BEGIN{exit !($ER > $ERR_MAX)}"; then DEGRADE="5xx rate ${ER}% > ${ERR_MAX}%"; fi
  if [ -n "$WF" ] && [ "$WF" -gt 0 ] 2>/dev/null; then DEGRADE="${DEGRADE:+$DEGRADE; }${WF} webhook failure(s) since last restart"; fi
fi

# 3) De-duplicated alerting on state change.
if [ "$STATUS" = "up" ] && [ -z "$DEGRADE" ]; then
  [ "$PREV" != "up" ] && notify "✅ Niche Finder RECOVERED — $URL is healthy again."
  echo up > "$STATE"; log "OK ($URL 200, status ok)"; exit 0
fi

if [ -n "$DEGRADE" ]; then
  [ "$PREV" != "degraded" ] && notify "⚠️ Niche Finder DEGRADED — $DEGRADE. Site is up but failing requests. Check logs."
  echo degraded > "$STATE"; log "DEGRADED: $DEGRADE"; exit 0
fi

# Down.
[ "$PREV" != "down" ] && notify "🔴 Niche Finder DOWN — $URL: $REASON. Investigate now."
echo down > "$STATE"; log "DOWN: $REASON"; exit 1
