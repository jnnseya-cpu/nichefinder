#!/usr/bin/env bash
# Niche Finder — restore + VERIFY a data backup. A backup that has never been
# restored is not a backup. This restores an archive into an ISOLATED target dir
# (never the live data by default) and validates every JSON store parses and
# reports record counts, so you can prove the archive is good.
#
# Usage:
#   NF_BACKUP_KEY_FILE=/etc/nf-backup.key ./nf-restore.sh <archive> [target_dir]
#
#   <archive>     path to nf-data-*.tar.gz or .tar.gz.enc
#   [target_dir]  where to extract (default: a fresh /tmp/nf-restore-<ts>).
#                 Pass an explicit dir to restore for real; the script refuses to
#                 write into a non-empty dir unless NF_RESTORE_FORCE=1.
set -euo pipefail

ARCHIVE="${1:-}"
TARGET="${2:-/tmp/nf-restore-$(date -u +%Y%m%d-%H%M%SZ)}"
KEY_FILE="${NF_BACKUP_KEY_FILE:-}"
log() { echo "[nf-restore] $*"; }

[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { log "usage: nf-restore.sh <archive> [target_dir]"; exit 1; }
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "${NF_RESTORE_FORCE:-0}" != "1" ]; then
  log "ABORT: target '$TARGET' is not empty. Set NF_RESTORE_FORCE=1 to overwrite."; exit 1
fi
mkdir -p "$TARGET"

TMPTAR=""
case "$ARCHIVE" in
  *.enc)
    [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ] || { log "ABORT: encrypted archive but NF_BACKUP_KEY_FILE not set"; exit 1; }
    TMPTAR="$(mktemp)"
    openssl enc -d -aes-256-cbc -pbkdf2 -in "$ARCHIVE" -out "$TMPTAR" -pass "file:$KEY_FILE"
    ;;
  *) TMPTAR="$ARCHIVE" ;;
esac

tar -xzf "$TMPTAR" -C "$TARGET"
[ "$TMPTAR" != "$ARCHIVE" ] && rm -f "$TMPTAR"

# The archive stores the data dir under its basename; find the extracted dir.
RESTORED="$(find "$TARGET" -maxdepth 2 -name 'wallets.json' -printf '%h\n' 2>/dev/null | head -1 || true)"
[ -n "$RESTORED" ] || RESTORED="$TARGET"
log "restored into: $RESTORED"

# VALIDATE every JSON store parses, and report record counts. Any parse failure
# means the archive is corrupt — fail loudly.
FAIL=0
for f in "$RESTORED"/*.json; do
  [ -e "$f" ] || continue
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null; then
    :
  elif head -c5 "$f" | grep -q 'NFE1:'; then
    log "  $(basename "$f"): encrypted store (NFE1 envelope) — parse skipped, presence OK"
    continue
  else
    log "  ✗ $(basename "$f"): INVALID JSON — archive is corrupt"; FAIL=1; continue
  fi
  # Record counts for the stores we know.
  node -e '
    const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const n=(o)=>o&&typeof o==="object"?Object.keys(o).length:0;
    const parts=[];
    if(d.wallets)parts.push("wallets="+n(d.wallets));
    if(d.users)parts.push("users="+n(d.users));
    if(d.docs||d.documents)parts.push("docs="+n(d.docs||d.documents));
    if(d.articles)parts.push("articles="+n(d.articles));
    if(d.codes)parts.push("referral_codes="+n(d.codes));
    console.log("  ✓ "+require("path").basename(process.argv[1])+(parts.length?"  ["+parts.join(" ")+"]":" (valid)"));
  ' "$f"
done

[ "$FAIL" = "0" ] && log "VERIFIED — backup restores and all stores are valid." || { log "RESTORE FAILED verification."; exit 1; }
