#!/usr/bin/env bash
# Notarize and staple one signed artifact: a .app (zipped for upload) or a .dmg.
#   scripts/release/notarize.sh <Kestrel.app | Kestrel.dmg>
# Profile: KESTREL_NOTARY_PROFILE (a notarytool keychain profile), default Vireo.
set -euo pipefail
TARGET="${1:?usage: notarize.sh <path.app|path.dmg>}"
PROFILE="${KESTREL_NOTARY_PROFILE:-Vireo}"
[ -e "$TARGET" ] || { echo "!! not found: $TARGET" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "$TARGET" in
  *.app) UPLOAD="$WORK/$(basename "$TARGET" .app).zip"; ditto -c -k --keepParent "$TARGET" "$UPLOAD" ;;
  *.dmg) UPLOAD="$TARGET" ;;
  *) echo "!! notarize.sh takes a .app or a .dmg" >&2; exit 1 ;;
esac

echo "==> Notarizing $(basename "$TARGET") (profile $PROFILE; this takes a few minutes)"
out="$(xcrun notarytool submit "$UPLOAD" --keychain-profile "$PROFILE" --wait 2>&1)" || true
echo "$out" | sed 's/^/    /'
if ! echo "$out" | grep -q "status: Accepted"; then
  id="$(echo "$out" | awk '/^  id: /{print $2; exit}')"
  [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
  echo "!! notarization of $TARGET was not accepted" >&2
  exit 1
fi
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"
