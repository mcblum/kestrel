#!/usr/bin/env bash
# Builds a signed, notarized, stapled Kestrel for Apple Silicon, from a clean tree, in one go:
#
#   preflight -> install -> simulator helper -> UI + server -> stage -> package + sign (electron-builder)
#   -> notarize + staple the app (afterSign) -> DMG + update zip from the stapled app
#   -> sign, notarize + staple the DMG -> update feed -> dist/release
#
#   scripts/release/make-release.sh [--skip-notarize] [--allow-dirty] [--feed <latest-mac.yml path or URL>]
#                                   [--version x.y.z]
#
#   --skip-notarize  sign only, for quick local iterations (the result will not open on another Mac)
#   --allow-dirty    build with uncommitted changes (test builds only)
#   --feed           refuse to build a version that is not newer than the one this feed already has
#   --version        put this version in the bundle instead of app/package.json's (updater tests only)
#
# Environment (names only; nothing secret is in the repo):
#   KESTREL_SIGN_ID         default "Developer ID Application: Matthew Blum (NLJAPE8842)"
#   KESTREL_NOTARY_PROFILE  default "Vireo" (a notarytool keychain profile on this Mac)
#
# Output, in dist/release: Kestrel.dmg (the download), Kestrel-<v>-arm64.dmg, Kestrel-<v>-arm64-mac.zip
# (what the updater downloads), its .blockmap, and latest-mac.yml (the feed, with relative URLs;
# publish.sh rewrites it with absolute ones). Nothing is uploaded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export KESTREL_SIGN_ID="${KESTREL_SIGN_ID:-Developer ID Application: Matthew Blum (NLJAPE8842)}"
export KESTREL_NOTARY_PROFILE="${KESTREL_NOTARY_PROFILE:-Vireo}"
OUT="$ROOT/dist/release"
BUILDER_OUT="$ROOT/dist/builder"

SKIP_NOTARIZE=0; VERSION_OVERRIDE=""; PREFLIGHT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-notarize) SKIP_NOTARIZE=1; PREFLIGHT_ARGS+=("$1") ;;
    --allow-dirty) PREFLIGHT_ARGS+=("$1") ;;
    --feed) PREFLIGHT_ARGS+=("$1" "${2:?--feed needs a path or URL}"); shift ;;
    --version) VERSION_OVERRIDE="${2:?--version needs x.y.z}"; PREFLIGHT_ARGS+=("$1" "$2"); shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
VERSION="${VERSION_OVERRIDE:-$(node -p "require('./app/package.json').version")}"
step() { echo; echo "==> $*"; }

scripts/release/preflight.sh "${PREFLIGHT_ARGS[@]+"${PREFLIGHT_ARGS[@]}"}"

step "Install"
pnpm install --frozen-lockfile
# pnpm can skip Electron's download script (it did once when a dependency changed); the packager needs it.
[ -d app/node_modules/electron/dist/Electron.app ] || (cd app/node_modules/electron && node install.js)

step "Simulator helper"
pnpm --filter @kestrel/app build:simhelper

step "UI"
pnpm --filter @kestrel/ui build

step "Stage (server bundle, node-pty, Claude Code binary, simulator helper)"
KESTREL_VERSION_OVERRIDE="$VERSION_OVERRIDE" node app/scripts/package/stage.mjs

step "Package and sign Kestrel $VERSION$( [ "$SKIP_NOTARIZE" = 1 ] && echo ' (not notarized)' || echo ', notarize and staple the app' )"
rm -rf "$BUILDER_OUT"
KESTREL_SKIP_NOTARIZE="$SKIP_NOTARIZE" app/node_modules/.bin/electron-builder --mac --arm64 --publish never \
  --config "$ROOT/app/electron-builder.config.cjs" --projectDir "$ROOT/dist/stage/app"
APP="$BUILDER_OUT/mac-arm64/Kestrel.app"
ZIP="Kestrel-$VERSION-arm64-mac.zip"
DMG="Kestrel-$VERSION-arm64.dmg"
codesign --verify --deep --strict --verbose=2 "$APP"

step "Sign the DMG$( [ "$SKIP_NOTARIZE" = 1 ] || echo ', notarize and staple it' )"
codesign --force --timestamp --sign "$KESTREL_SIGN_ID" "$BUILDER_OUT/$DMG"
[ "$SKIP_NOTARIZE" = 1 ] || scripts/release/notarize.sh "$BUILDER_OUT/$DMG"

step "Collect into dist/release"
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$BUILDER_OUT/$ZIP" "$BUILDER_OUT/$ZIP.blockmap" "$BUILDER_OUT/$DMG" "$OUT/"
cp "$OUT/$DMG" "$OUT/Kestrel.dmg"
# electron-builder's DMG blockmap is stale once the DMG is stapled, and the Mac updater only uses the zip's.
node scripts/release/write-feed.mjs --dir "$OUT" --version "$VERSION"

if [ "$SKIP_NOTARIZE" != 1 ]; then
  step "Gatekeeper"
  spctl -a -vv -t exec "$APP"
  spctl -a -vv -t open --context context:primary-signature "$OUT/Kestrel.dmg"
fi

step "Kestrel $VERSION"
( cd "$OUT" && ls -lh | sed 1d | awk '{print "    " $5 "\t" $9}' )
echo "    app: $APP"
echo "    Publishing is a separate, approved step: scripts/release/publish.sh (see RELEASING.md)."
