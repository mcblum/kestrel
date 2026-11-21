#!/usr/bin/env bash
# Builds the app icon from the master: Brand/masters/bird.svg -> Brand/exports/icon.icns (app and
# DMG volume icon), icon-512.png (the Dock icon of a checkout) and the iconset PNGs.
# Every size is rendered from the vector master by Electron's Chromium, not scaled down from a
# bitmap, so 16 and 32 px stay sharp. Repeatable; commit the results with the master.
#   scripts/release/make-icon.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MASTER="$ROOT/Brand/masters/bird.svg"
OUT="$ROOT/Brand/exports"
ELECTRON="$ROOT/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
RENDER="$ROOT/scripts/release/render-svg.mjs"

[ -f "$MASTER" ] || { echo "!! no master at $MASTER" >&2; exit 1; }
[ -x "$ELECTRON" ] || { echo "!! Electron is not installed (pnpm install)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET" "$OUT"

render() { # size file
  # Its own profile folder, so it never meets a running Kestrel's.
  "$ELECTRON" "$RENDER" --user-data-dir="$WORK/profile" "$MASTER" "$2" "$1" >/dev/null 2>"$WORK/render.log" \
    || { cat "$WORK/render.log" >&2; echo "!! rendering $1 px failed" >&2; exit 1; }
}

for size in 16 32 128 256 512; do
  render "$size" "$ICONSET/icon_${size}x${size}.png"
  render "$((size * 2))" "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$OUT/icon.icns"
for size in 16 32 128 512 1024; do
  render "$size" "$OUT/icon-$size.png"
done
echo "==> $OUT/icon.icns ($(du -h "$OUT/icon.icns" | cut -f1)) and icon-{16,32,128,512,1024}.png"
