#!/usr/bin/env bash
# Checks before a release build. Sourced by make-release.sh with its settings, or run alone:
#   scripts/release/preflight.sh [--skip-notarize] [--allow-dirty] [--feeds <base URL or folder>] [--version x.y.z | x.y.z-beta.n]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SIGN_ID="${KESTREL_SIGN_ID:-Developer ID Application: Matthew Blum (NLJAPE8842)}"
NOTARY_PROFILE="${KESTREL_NOTARY_PROFILE:-Vireo}"
SKIP_NOTARIZE=0; ALLOW_DIRTY=0; FEEDS=""; VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --feeds) FEEDS="${2:?--feeds needs a base URL or a folder}"; shift ;;
    --version) VERSION="${2:?--version needs x.y.z}"; shift ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$VERSION" ] || VERSION="$(node -p "require('$ROOT/app/package.json').version")"
fail() { echo "!! preflight: $*" >&2; exit 1; }

CHANNEL="$(node "$ROOT/scripts/release/version.mjs" channel "$VERSION")" || fail "app/package.json's version cannot be released"
echo "==> Preflight for Kestrel $VERSION ($CHANNEL)"
[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "release builds are made on an Apple Silicon Mac"

# The release's notes, before anything is built: a release has whats-new/<version>.md, which is both
# the app's What's new page and the release's notes on the host (release-notes.mjs). A beta may have none.
said="$(node "$ROOT/scripts/release/release-notes.mjs" check "$VERSION" 2>&1)" || fail "${said#!! }"
echo "    notes: $said"

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

# The one check of whether this version is due, against the feeds of its channel.
if [ -n "$FEEDS" ]; then
  said="$("$ROOT/scripts/release/release-needed.sh" --feeds "$FEEDS" --version "$VERSION" 2>&1)" || fail "$said"
  echo "    feeds: $said"
fi
echo "    ok"
