#!/usr/bin/env bash
# Is a release of this version due? Asked once, here, by every CI job that takes part in a
# release and by make-release.sh's preflight, so they all agree. The Mac feeds are the record: a
# release always has a Mac build, and publish.sh writes its feeds last.
#
#   scripts/release/release-needed.sh [--feeds <base URL ending in / or a folder>] [--version <v>]
#
# The version is app/package.json's (or --version). Its channel decides what it is compared with
# (app/release-channel.mjs, through version.mjs):
#   1.2.3          a release: due when newer than what latest-mac.yml serves
#   1.2.3-beta.4   a beta:    due when newer than both latest-mac.yml and beta-mac.yml, so a beta
#                             never follows the release it leads to
#
# Exit 0   due: nothing is published yet, or the feeds serve an older version.
# Exit 1   not due, with one line saying why (the feeds already serve this version or a later one).
# Exit 2   cannot tell (a feed could not be fetched, or the version is not 1.2.3 or 1.2.3-beta.4):
#          never read as "not due", so an outage fails loudly instead of quietly skipping a release.
#
# The feeds are public; no token is needed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FEEDS="${KESTREL_RELEASE_FEEDS:-https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/}"
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --feeds) FEEDS="${2:?--feeds needs a base URL or a folder}"; shift ;;
    --version) VERSION="${2:?--version needs a version}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$VERSION" ] || VERSION="$(node -p "require('$ROOT/app/package.json').version" 2>/dev/null)"
node "$ROOT/scripts/release/version.mjs" channel "$VERSION" >/dev/null || exit 2

body="$(mktemp)"; trap 'rm -f "$body"' EXIT
# The version a feed file serves, '' when it is not there (nothing published on that feed yet).
served() {
  local name="$1" code
  case "$FEEDS" in
    http://*|https://*)
      local url="${FEEDS%/}/$name"
      code="$(curl -sS -L -o "$body" -w '%{http_code}' --max-time 20 "$url" 2>/dev/null)" || code=000
      case "$code" in
        # A page that is not a feed (a sign-in page, when the releases project is not public) is not "nothing published".
        200) grep -q '^version: ' "$body" || { echo "!! $url answered, but not with a feed (is the releases project public?)" >&2; return 2; } ;;
        404) : > "$body" ;;
        *) echo "!! could not fetch the feed $url (HTTP $code)" >&2; return 2 ;;
      esac ;;
    *)
      if [ -f "$FEEDS/$name" ]; then cat "$FEEDS/$name" > "$body"; else : > "$body"; fi ;;
  esac
  sed -n 's/^version: *//p' "$body" | head -1 | tr -d "'\"\r "
}

stable="$(served latest-mac.yml)" || exit 2
beta="$(served beta-mac.yml)" || exit 2
node "$ROOT/scripts/release/version.mjs" due "$VERSION" "$stable" "$beta"
