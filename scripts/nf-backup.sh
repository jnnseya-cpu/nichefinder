#!/usr/bin/env bash
# Niche Finder — data backup. Snapshots the flat-file system of record (wallets,
# accounts, documents, articles, referrals, leads) into a timestamped, integrity-
# checked, optionally-encrypted archive, and prunes old ones. Zero dependencies
# beyond tar + gzip (+ openssl if you encrypt).
#
# Env:
#   NF_DATA_DIR        dir holding the *.json stores (default: /srv/nichefinder/data)
#   NF_BACKUP_DIR      where archives are written    (default: /var/backups/nichefinder)
#   NF_BACKUP_KEEP     how many archives to retain    (default: 168 — ~7 days hourly)
#   NF_BACKUP_KEY_FILE path to a file with an encryption passphrase. If set, the
#                      archive is AES-256 encrypted (openssl, pbkdf2). If UNSET the
#                      archive is plaintext and the script WARNS — money + auth data
#                      should never sit unencrypted off-box.
#   NF_BACKUP_REMOTE   optional rsync/scp target (e.g. user@host:/backups). If set,
#                      each archive is copied off the machine — a backup on the same
#                      disk as the data does not survive a disk/host loss.
set -euo pipefail

DATA_DIR="${NF_DATA_DIR:-/srv/nichefinder/data}"
DEST="${NF_BACKUP_DIR:-/var/backups/nichefinder}"
KEEP="${NF_BACKUP_KEEP:-168}"
KEY_FILE="${NF_BACKUP_KEY_FILE:-}"
REMOTE="${NF_BACKUP_REMOTE:-}"
TS="$(date -u +%Y%m%d-%H%M%SZ)"
log() { echo "[nf-backup $(date -u +%H:%M:%SZ)] $*"; }

[ -d "$DATA_DIR" ] || { log "ABORT: data dir not found: $DATA_DIR"; exit 1; }
# Refuse to back up an empty data dir — that usually means a wrong path, and a
# good backup schedule must never quietly overwrite real archives with nothing.
if [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then log "ABORT: data dir is empty: $DATA_DIR"; exit 1; fi

mkdir -p "$DEST"
RAW="$DEST/nf-data-$TS.tar.gz"
tar -czf "$RAW" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

# Integrity check: the archive must list back cleanly, or it is not a backup.
if ! tar -tzf "$RAW" >/dev/null 2>&1; then log "ABORT: archive failed integrity check"; rm -f "$RAW"; exit 1; fi

OUT="$RAW"
if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
  ENC="$DEST/nf-data-$TS.tar.gz.enc"
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$RAW" -out "$ENC" -pass "file:$KEY_FILE"
  rm -f "$RAW"
  OUT="$ENC"
  log "encrypted archive written: $OUT ($(du -h "$OUT" | cut -f1))"
else
  log "WARNING: NF_BACKUP_KEY_FILE not set — archive is UNENCRYPTED: $OUT"
fi

# Off-box copy (optional but strongly recommended).
if [ -n "$REMOTE" ]; then
  if command -v rsync >/dev/null 2>&1; then rsync -a "$OUT" "$REMOTE/" && log "copied off-box via rsync -> $REMOTE"
  else scp -q "$OUT" "$REMOTE/" && log "copied off-box via scp -> $REMOTE"; fi
fi

# Prune: keep the newest $KEEP archives, delete the rest.
mapfile -t OLD < <(ls -1t "$DEST"/nf-data-*.tar.gz* 2>/dev/null | tail -n +"$((KEEP+1))")
for f in "${OLD[@]:-}"; do [ -n "$f" ] && rm -f "$f" && log "pruned $f"; done

COUNT="$(ls -1 "$DEST"/nf-data-*.tar.gz* 2>/dev/null | wc -l | tr -d ' ')"
log "OK — backup complete. $COUNT archive(s) retained in $DEST"
