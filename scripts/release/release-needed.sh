#!/usr/bin/env bash
# Is a release of this version due? Asked once, here, by every CI job that takes part in a
# release, so they all agree: the version in app/package.json is newer than the one the live
# Mac feed serves. The Mac feed is the record: a release always has a Mac build, and publish.sh
# writes that feed last.
#
#   scripts/release/release-needed.sh [--feed <latest-mac.yml path or URL>]
#
# Exit 0   due: nothing is published yet, or the feed's version is older than this one.
# Exit 1   not due, with one line saying why (the feed already serves this version or a later one).
# Exit 2   cannot tell (the feed could not be fetched): never read as "not due", so an outage
#          fails loudly instead of quietly skipping a release.
#
# The feed is public; no token is needed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FEED="${KESTREL_RELEASE_FEED:-https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/latest-mac.yml}"
while [ $# -gt 0 ]; do
  case "$1" in
    --feed) FEED="${2:?--feed needs a path or URL}"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(node -p "require('$ROOT/app/package.json').version" 2>/dev/null)"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "!! app/package.json has no version like 1.2.3" >&2; exit 2 ;;
esac

body="$(mktemp)"; trap 'rm -f "$body"' EXIT
case "$FEED" in
  http://*|https://*)
    code="$(curl -sS -L -o "$body" -w '%{http_code}' --max-time 20 "$FEED" 2>/dev/null)" || code=000
    case "$code" in
      # A page that is not a feed (a sign-in page, when the releases project is not public) is not "nothing published".
      200) grep -q '^version: ' "$body" || { echo "!! $FEED answered, but not with a feed (is the releases project public?)" >&2; exit 2; } ;;
      404) : > "$body" ;; # no feed yet: the first release
      *) echo "!! could not fetch the feed $FEED (HTTP $code)" >&2; exit 2 ;;
    esac ;;
  *)
    if [ -f "$FEED" ]; then cat "$FEED" > "$body"; else : > "$body"; fi ;;
esac

PUBLISHED="$(sed -n 's/^version: *//p' "$body" | head -1 | tr -d "'\"\r ")"
if [ -z "$PUBLISHED" ]; then
  echo "nothing is published yet: a release of $VERSION is due"
  exit 0
fi
# Compared part by part as numbers (sort -V is not on every Mac).
newer="$(node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) { console.log((a[i] || 0) > (b[i] || 0) ? "yes" : "no"); process.exit(0); }
  console.log("no");
' "$VERSION" "$PUBLISHED")"
if [ "$newer" = yes ]; then
  echo "the feed serves $PUBLISHED: a release of $VERSION is due"
  exit 0
fi
echo "the feed already serves $PUBLISHED, and app/package.json says $VERSION: no release due (bump the version to cut one)"
exit 1
