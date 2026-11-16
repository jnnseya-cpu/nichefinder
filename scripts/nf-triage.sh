#!/usr/bin/env bash
# Niche Finder — one-shot triage. READ-ONLY: it changes nothing (no restarts, no
# writes, no deploys) — it just prints a health report so a 502 / outage can be
# diagnosed in one command. Zero dependencies beyond coreutils + curl; every
# probe is guarded, so missing tools (docker, ss, journalctl) degrade to a note
# instead of failing the report.
#
# Usage (run on the VPS, as root so journald/docker are readable):
#   sudo bash scripts/nf-triage.sh
#
# Env overrides:
#   NF_SERVICE     systemd unit for the gateway   (default: nichefinder)
#   NF_HEALTH_URL  local health endpoint          (default: http://localhost:8080/v1/health)
#   NF_PUBLIC_URL  public health endpoint         (optional, e.g. https://nichefinderhq.com/v1/health)
#   NF_LOG_LINES   recent log lines to scan        (default: 80)
#
# Exit code: 0 if the gateway health check returns 200/ok, 1 otherwise — so it
# doubles as a scriptable check. The report is always printed either way.
set -u

SERVICE="${NF_SERVICE:-nichefinder}"
HEALTH_URL="${NF_HEALTH_URL:-http://localhost:8080/v1/health}"
PUBLIC_URL="${NF_PUBLIC_URL:-}"
LOG_LINES="${NF_LOG_LINES:-80}"

have() { command -v "$1" >/dev/null 2>&1; }
hr()   { printf '\n== %s ==\n' "$1"; }
note() { printf '   %s\n' "$*"; }

echo "Niche Finder triage — $(date -u +%FT%TZ) — host $(hostname 2>/dev/null || echo '?')"
echo "service=$SERVICE  health=$HEALTH_URL"

# ── 1. Gateway service ──────────────────────────────────────────────────────
hr "1. Gateway service ($SERVICE)"
if have systemctl; then
  STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  note "active: ${STATE:-unknown}   enabled: $(systemctl is-enabled "$SERVICE" 2>/dev/null || echo '?')"
  systemctl status "$SERVICE" --no-pager -n 0 2>/dev/null | sed -n '1,6p' | sed 's/^/   /'
  WDIR="$(systemctl show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"
  note "WorkingDirectory: ${WDIR:-<unset>}   (this is the repo path to pull/deploy in)"
  note "restarts since boot: $(systemctl show "$SERVICE" -p NRestarts --value 2>/dev/null || echo '?')"
else
  note "systemctl not available on this host."
fi

# ── 2. Gateway health (local) ───────────────────────────────────────────────
hr "2. Gateway health — local upstream"
HEALTH_OK=1
if have curl; then
  BODY_FILE="$(mktemp 2>/dev/null || echo /tmp/nf-triage.$$)"
  # -w already prints 000 on a failed connection; don't append another via ||.
  CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -m 10 "$HEALTH_URL" 2>/dev/null)"; CODE="${CODE:-000}"
  BODY="$(head -c 500 "$BODY_FILE" 2>/dev/null)"; rm -f "$BODY_FILE"
  note "HTTP $CODE"
  note "body: ${BODY:-<empty>}"
  if [ "$CODE" = "200" ] && printf '%s' "$BODY" | grep -q '"status":"ok"'; then
    note "=> upstream is UP and healthy."; HEALTH_OK=0
  elif [ "$CODE" = "000" ]; then
    note "=> NOTHING is listening/answering on that port (process down, or wrong port)."
  else
    note "=> upstream answered but not healthy (see body)."
  fi
else
  note "curl not available — cannot probe health."
fi

# ── 3. Public health (optional) ─────────────────────────────────────────────
if [ -n "$PUBLIC_URL" ] && have curl; then
  hr "3. Gateway health — public (through the proxy)"
  PCODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "$PUBLIC_URL" 2>/dev/null)"; PCODE="${PCODE:-000}"
  note "HTTP $PCODE  ($PUBLIC_URL)"
  case "$PCODE" in
    200) note "=> public path healthy." ;;
    502|503|504) note "=> proxy is up but cannot reach this upstream (compare with section 2)." ;;
    000) note "=> could not connect (DNS/TLS/proxy down)." ;;
    *)   note "=> unexpected status." ;;
  esac
fi

# ── 4. Resources (the usual silent killers) ─────────────────────────────────
hr "4. Resources"
if have df; then df -h / 2>/dev/null | sed 's/^/   /'; fi
if have free; then free -m 2>/dev/null | sed 's/^/   /'; fi
# inode exhaustion presents as "disk full" with bytes free
if have df; then
  IUSE="$(df -i / 2>/dev/null | awk 'NR==2{print $5}')"
  note "inode use on /: ${IUSE:-?}"
fi

# ── 5. Recent gateway errors ────────────────────────────────────────────────
hr "5. Recent gateway errors (last $LOG_LINES lines, filtered)"
if have journalctl; then
  journalctl -u "$SERVICE" -n "$LOG_LINES" --no-pager 2>/dev/null \
    | grep -iE 'error|unhandled|rejection|invalid|throw|EADDR|ECONN|fatal|exit|killed|oom' \
    | tail -20 | sed 's/^/   /' || true
  note "(none of the above = no obvious errors in the window)"
  # OOM kills are logged by the kernel, not the unit:
  OOM="$(journalctl -k -n 400 --no-pager 2>/dev/null | grep -i 'killed process' | tail -3)"
  [ -n "$OOM" ] && { note "kernel OOM-killer activity:"; printf '%s\n' "$OOM" | sed 's/^/   /'; }
else
  note "journalctl not available."
fi

# ── 6. What is listening (proxy ↔ upstream map) ─────────────────────────────
hr "6. Listening sockets (80 / 443 / 8080)"
if have ss; then
  ss -ltnp 2>/dev/null | grep -E ':(80|443|8080)\b' | sed 's/^/   /' || note "nothing on 80/443/8080."
elif have netstat; then
  netstat -ltnp 2>/dev/null | grep -E ':(80|443|8080)\b' | sed 's/^/   /' || note "nothing on 80/443/8080."
else
  note "ss/netstat not available."
fi

# ── 7. Reverse proxy ────────────────────────────────────────────────────────
hr "7. Reverse proxy (fronts all the vhosts)"
FOUND=0
if have systemctl; then
  for p in caddy nginx apache2 httpd traefik; do
    ST="$(systemctl is-active "$p" 2>/dev/null || true)"
    [ -n "$ST" ] && [ "$ST" != "unknown" ] && { note "systemd $p: $ST"; FOUND=1; }
  done
fi
if have docker; then
  DP="$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | grep -iE 'caddy|nginx|traefik|proxy' || true)"
  if [ -n "$DP" ]; then note "docker proxy containers:"; printf '%s\n' "$DP" | sed 's/^/   /'; FOUND=1
  else note "docker present; no caddy/nginx/traefik/proxy container matched (try: docker ps)."; fi
fi
[ "$FOUND" = 0 ] && note "no obvious reverse proxy found via systemd/docker — check your panel (CloudPanel/Plesk/etc.)."

# ── 8. Recent deploy activity ───────────────────────────────────────────────
hr "8. Recent deploy (auto-deploy log, if present)"
for f in /var/log/nf-deploy-test.log /var/log/nf-deploy.log; do
  [ -f "$f" ] && { note "$f (tail):"; tail -5 "$f" 2>/dev/null | sed 's/^/   /'; }
done
if have systemctl; then
  note "nf-deploy.timer: $(systemctl is-active nf-deploy.timer 2>/dev/null || echo 'absent')   nf-monitor.timer: $(systemctl is-active nf-monitor.timer 2>/dev/null || echo 'absent')"
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
hr "Verdict"
if [ "$HEALTH_OK" = 0 ]; then
  note "Gateway upstream is HEALTHY. If the public site still 502s, the issue is the proxy→upstream mapping (section 6/7), not the app."
else
  note "Gateway upstream is NOT healthy (section 2). Restart it, then re-run:"
  note "   sudo systemctl restart $SERVICE && sudo bash scripts/nf-triage.sh"
fi
exit "$HEALTH_OK"
