#!/usr/bin/env bash
# Regenerate all PWA icons + iOS splash screens, then re-inject the <head> block.
# Run from frontend/pwa/ . Requires a Chromium/headless-shell binary (set CHROME).
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell}"
shot(){ "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size="$1,$2" --screenshot="$3" "file://$PWD/$4"; }

# Icons (into ../ root)
shot 192 192 ../icon-192.png          src-icon-any.html
shot 512 512 ../icon-512.png          src-icon-any.html
shot 512 512 ../icon-maskable-512.png src-icon-maskable.html
shot 180 180 ../apple-touch-icon.png  src-icon-any.html

# iOS splash matrix — "cssW cssH ratio" (portrait); also renders landscape.
mkdir -p splash
while read -r cw ch r; do
  [ -z "$cw" ] && continue
  pw=$((cw*r)); ph=$((ch*r))
  shot "$pw" "$ph" "splash/splash-${pw}x${ph}.png" src-splash.html
  shot "$ph" "$pw" "splash/splash-${ph}x${pw}.png" src-splash.html
done <<'DEVICES'
375 667 2
414 736 3
375 812 3
414 896 2
414 896 3
390 844 3
360 780 3
428 926 3
393 852 3
430 932 3
768 1024 2
810 1080 2
834 1112 2
834 1194 2
1024 1366 2
DEVICES

# Re-inject the <head> block into every ../*.html
( cd .. && node pwa/inject.js )
echo "done."
