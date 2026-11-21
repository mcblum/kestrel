#!/usr/bin/env bash
# Checks before a release build. Sourced by make-release.sh with its settings, or run alone:
#   scripts/release/preflight.sh [--skip-notarize] [--allow-dirty] [--feed <latest-mac.yml path or URL>] [--version x.y.z]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SIGN_ID="${KESTREL_SIGN_ID:-Developer ID Application: Matthew Blum (NLJAPE8842)}"
NOTARY_PROFILE="${KESTREL_NOTARY_PROFILE:-Vireo}"
SKIP_NOTARIZE=0; ALLOW_DIRTY=0; FEED=""; VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --feed) FEED="${2:?--feed needs a path or URL}"; shift ;;
    --version) VERSION="${2:?--version needs x.y.z}"; shift ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$VERSION" ] || VERSION="$(node -p "require('$ROOT/app/package.json').version")"
fail() { echo "!! preflight: $*" >&2; exit 1; }

echo "==> Preflight for Kestrel $VERSION"
[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "release builds are made on an Apple Silicon Mac"

# Tracked files only: untracked scratch folders never reach the bundle.
if [ "$ALLOW_DIRTY" != 1 ] && [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  git -C "$ROOT" status --short --untracked-files=no >&2
  fail "the working tree has uncommitted changes (commit them, or --allow-dirty for a test build)"
fi
echo "    tree: $( [ "$ALLOW_DIRTY" = 1 ] && echo 'not checked (--allow-dirty)' || echo clean ) at $(git -C "$ROOT" rev-parse --short HEAD)"

security find-identity -v -p codesigning | grep -qF "\"$SIGN_ID\"" || fail "signing identity not in the keychain: $SIGN_ID"
echo "    identity: $SIGN_ID"

if [ "$SKIP_NOTARIZE" = 1 ]; then
  echo "    notarization: skipped (--skip-notarize)"
else
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || fail "notarytool keychain profile '$NOTARY_PROFILE' does not work (xcrun notarytool store-credentials)"
  echo "    notary profile: $NOTARY_PROFILE"
fi

[ -x "$(command -v pnpm)" ] || fail "pnpm is not on PATH"
xcrun --find swiftc >/dev/null 2>&1 || fail "Xcode's swiftc is needed for the simulator helper"

if [ -n "$FEED" ]; then
  case "$FEED" in
    http*://*) live="$(curl -fsSL "$FEED" 2>/dev/null || true)" ;;
    *) live="$(cat "$FEED" 2>/dev/null || true)" ;;
  esac
  published="$(printf '%s\n' "$live" | sed -n 's/^version: *//p' | head -1)"
  if [ -n "$published" ]; then
    newest="$(printf '%s\n%s\n' "$published" "$VERSION" | sort -V | tail -1)"
    { [ "$VERSION" != "$published" ] && [ "$newest" = "$VERSION" ]; } || fail "the feed already has $published; $VERSION is not newer (bump app/package.json)"
    echo "    feed: has $published, building $VERSION"
  else
    echo "    feed: nothing published at $FEED"
  fi
fi
echo "    ok"
