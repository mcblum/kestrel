#!/usr/bin/env bash
# Publishes the release make-release.sh left in dist/release to the public kestrel/releases
# project on starfish. House pattern (Shrike Packaging/gitlab-release.sh, Bellbird
# scripts/publish-macos.sh), with electron-updater's feed in place of Sparkle's appcast:
#
#   1. checks  the DMG and the app in the zip are signed, notarized and stapled; nothing in the
#              artifacts carries a local home path, the owner's email or a token
#   2. feed    the live feed's version must be older than this one (--force to replace it)
#   3. upload  zip, zip blockmap and DMG to the generic package registry, package `kestrel`,
#              version <v> (replacing that version's files if they are already there)
#   4. release GitLab Release v<v> with asset links; the DMG link's filepath is /Kestrel.dmg so
#              …/-/releases/permalink/latest/downloads/Kestrel.dmg is the download
#   5. feed    latest-mac.yml, with absolute URLs into the package registry, committed to `main`
#              (last, so the feed never names a file that is not there yet)
#   6. verify  fetch the public feed and HEAD every URL in it, the blockmap and the permalink
#
#   scripts/release/publish.sh [--dry-run] [--force] [--dir dist/release]
#
#   --dry-run  run the checks and the read-only lookups, and print every request that would
#              change something instead of sending it
#   --force    publish even if the live feed already has this version or a newer one
#
# Environment (names only; nothing secret is in the repo):
#   KESTREL_GITLAB_TOKEN      api-scoped token; else the keychain item (account vireo, service gitlab-token)
#   GITLAB_HOST               default starfish.nationalmachine.io
#   KESTREL_RELEASES_PROJECT  default kestrel/releases
#   GITLAB_UPLOAD_HOST        optional direct URL for the big uploads (e.g. the GitLab box on the
#                             LAN, past the edge's upload cap); the Host header is set for it
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${GITLAB_HOST:-starfish.nationalmachine.io}"
PUBLIC="https://$HOST"
PROJECT="${KESTREL_RELEASES_PROJECT:-kestrel/releases}"
PACKAGE="kestrel"
UPLOAD="${GITLAB_UPLOAD_HOST:-$PUBLIC}"
DIR="$ROOT/dist/release"
DRY=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    --dir) DIR="${2:?--dir needs a folder}"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
fail() { echo "!! publish: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

VERSION="$(sed -n 's/^version: *//p' "$DIR/latest-mac.yml" 2>/dev/null | head -1)"
[ -n "$VERSION" ] || fail "no release in $DIR (run scripts/release/make-release.sh)"
ZIP="Kestrel-$VERSION-arm64-mac.zip"
DMG="Kestrel-$VERSION-arm64.dmg"
for f in "$ZIP" "$ZIP.blockmap" "$DMG" Kestrel.dmg; do [ -f "$DIR/$f" ] || fail "missing $DIR/$f"; done
cmp -s "$DIR/$DMG" "$DIR/Kestrel.dmg" || fail "Kestrel.dmg is not the same file as $DMG"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. checks ------------------------------------------------------------------------------
step "Check Kestrel $VERSION: notarized, stapled, nothing private inside"
xcrun stapler validate "$DIR/Kestrel.dmg" >/dev/null || fail "the DMG has no stapled notarization ticket"
spctl -a -t open --context context:primary-signature "$DIR/Kestrel.dmg" 2>/dev/null || fail "Gatekeeper rejects the DMG"
ditto -x -k "$DIR/$ZIP" "$WORK/zip"
APP="$WORK/zip/Kestrel.app"
[ -d "$APP" ] || fail "the zip does not hold Kestrel.app at its top"
codesign --verify --deep --strict "$APP" 2>/dev/null || fail "the app in the zip does not verify"
xcrun stapler validate "$APP" >/dev/null || fail "the app in the zip has no stapled ticket"
spctl -a -t exec "$APP" 2>/dev/null || fail "Gatekeeper rejects the app in the zip"
zipped_version="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
[ "$zipped_version" = "$VERSION" ] || fail "the zip holds Kestrel $zipped_version, the feed says $VERSION"
echo "    DMG and app: signed, notarized, stapled; Gatekeeper accepts both"

# ---- token ---------------------------------------------------------------------------------
TOKEN="${KESTREL_GITLAB_TOKEN:-$(security find-generic-password -a vireo -s gitlab-token -w 2>/dev/null || true)}"
[ -n "$TOKEN" ] || fail "no GitLab token: set KESTREL_GITLAB_TOKEN or store one in the keychain (account vireo, service gitlab-token)"
# The token goes to curl and grep in files, never on a command line or in the output.
HEADER="$WORK/auth-header"
PRIVATE="$WORK/private-strings"
EMAIL="$(git -C "$ROOT" config user.email || true)"
( umask 077
  printf 'PRIVATE-TOKEN: %s\n' "$TOKEN" > "$HEADER"
  { printf '%s\n' "$HOME/" "$TOKEN"; [ -z "$EMAIL" ] || printf '%s\n' "$EMAIL"; } > "$PRIVATE" )
unset TOKEN
# A GitLab token's shape. (The bare prefix is not enough: the Claude binary and the Agent SDK carry
# secret-scanner rules that name it.)
TOKEN_SHAPE='glpat-[A-Za-z0-9_-]{20,}'
private_in() { grep -qaF -f "$PRIVATE" "$@" 2>/dev/null || grep -qaE "$TOKEN_SHAPE" "$@" 2>/dev/null; }

# The release is public: no local home path, the owner's email or a token in anything that ships.
unzip -Z1 "$DIR/$ZIP" > "$WORK/zip-list"
! private_in "$WORK/zip-list" || fail "a file name in the zip contains a private string"
! private_in "$DIR/latest-mac.yml" || fail "latest-mac.yml contains a private string"
hits="$( { grep -rlaF -f "$PRIVATE" "$APP"; grep -rlaE "$TOKEN_SHAPE" "$APP"; } 2>/dev/null | sed "s|$WORK/zip/||" | sort -u | head -5 || true)"
[ -z "$hits" ] || { echo "$hits" >&2; fail "files in the app contain a private string (listed above)"; }
echo "    no home path, email or token in the zip's names, the app's files or the feed"

# ---- API -------------------------------------------------------------------------------------
ENC_PROJECT="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PROJECT")"

api_get() { # path -> body on stdout; fails on HTTP errors
  echo "    GET  $PUBLIC/api/v4$1" >&2
  curl -fsS -H @"$HEADER" "$PUBLIC/api/v4$1"
}
api_send() { # method path [curl args...]: printed only on --dry-run
  local method="$1" path="$2"; shift 2
  if [ "$DRY" = 1 ]; then echo "    (dry run) $method $PUBLIC/api/v4$path $*" >&2; return 0; fi
  echo "    $method $PUBLIC/api/v4$path" >&2
  curl -fsS -X "$method" -H @"$HEADER" "$@" "$PUBLIC/api/v4$path"
}
json() { local expr="$1"; shift; python3 -c "import json,sys; d=json.load(sys.stdin); print($expr)" "$@"; }

step "Project $PROJECT on $HOST"
PROJ_JSON="$(api_get "/projects/$ENC_PROJECT")" || fail "cannot read $PROJECT (does it exist, and can the token see it?)"
PROJECT_ID="$(echo "$PROJ_JSON" | json 'd["id"]')"
VISIBILITY="$(echo "$PROJ_JSON" | json 'd.get("visibility")')"
DEFAULT_BRANCH="$(echo "$PROJ_JSON" | json 'd.get("default_branch") or ""')"
[ "$VISIBILITY" = "public" ] || fail "$PROJECT is $VISIBILITY; the updater and the download need it public"
echo "    id $PROJECT_ID, public, default branch ${DEFAULT_BRANCH:-none yet}"
[ -z "$DEFAULT_BRANCH" ] || [ "$DEFAULT_BRANCH" = "main" ] || fail "$PROJECT's default branch is $DEFAULT_BRANCH; the feed URL reads main"
REGISTRY="$PUBLIC/api/v4/projects/$PROJECT_ID/packages/generic/$PACKAGE/$VERSION/"
FEED_URL="$PUBLIC/$PROJECT/-/raw/main/latest-mac.yml"

# ---- 2. the live feed ------------------------------------------------------------------------
step "Live feed"
echo "    GET  $FEED_URL (public, no token)"
live="$(curl -fsSL "$FEED_URL?nocache=$(date +%s)" 2>/dev/null | sed -n 's/^version: *//p' | head -1 || true)"
if [ -n "$live" ]; then
  newest="$(printf '%s\n%s\n' "$live" "$VERSION" | sort -V | tail -1)"
  if [ "$live" = "$VERSION" ] || [ "$newest" != "$VERSION" ]; then
    [ "$FORCE" = 1 ] || fail "the live feed has $live; $VERSION is not newer (--force replaces it)"
    echo "    live feed has $live; replacing with $VERSION (--force)"
  else
    echo "    live feed has $live; publishing $VERSION"
  fi
else
  echo "    no live feed yet; publishing $VERSION"
fi

# ---- 3. upload -------------------------------------------------------------------------------
step "Upload to the package registry ($PACKAGE $VERSION)"
existing="$(api_get "/projects/$PROJECT_ID/packages?package_type=generic&package_name=$PACKAGE&package_version=$VERSION" | json '" ".join(str(p["id"]) for p in d if p.get("version")==sys.argv[1] and p.get("name")==sys.argv[2])' "$VERSION" "$PACKAGE" 2>/dev/null || true)"
for id in $existing; do api_send DELETE "/projects/$PROJECT_ID/packages/$id" >/dev/null; done
UPLOAD_ARGS=()
# The direct upload route (the GitLab box itself) needs the public name; the public route must not get one.
[ "$UPLOAD" = "$PUBLIC" ] || UPLOAD_ARGS=(--http1.1 -H "Host: $HOST")
for f in "$ZIP" "$ZIP.blockmap" "$DMG"; do
  path="/projects/$PROJECT_ID/packages/generic/$PACKAGE/$VERSION/$f"
  if [ "$DRY" = 1 ]; then echo "    (dry run) PUT $UPLOAD/api/v4$path  <- $f ($(du -h "$DIR/$f" | cut -f1))"; continue; fi
  echo "    PUT  $UPLOAD/api/v4$path" >&2
  curl -fsS --max-time 1800 -X PUT -H @"$HEADER" "${UPLOAD_ARGS[@]+"${UPLOAD_ARGS[@]}"}" --upload-file "$DIR/$f" "$UPLOAD/api/v4$path" >/dev/null \
    || fail "uploading $f failed"
done

# A Release hangs its tag on a ref: an empty project gets a first commit on main.
if [ -z "$DEFAULT_BRANCH" ]; then
  readme="$(printf '# Kestrel releases\n\nDownloads and the update feed for Kestrel for Mac.\n\n- Download: %s/%s/-/releases/permalink/latest/downloads/Kestrel.dmg\n- Update feed: %s\n' "$PUBLIC" "$PROJECT" "$FEED_URL")"
  python3 -c 'import json,sys; print(json.dumps({"branch":"main","content":sys.argv[1],"commit_message":"Kestrel releases"}))' "$readme" > "$WORK/readme.json"
  api_send POST "/projects/$PROJECT_ID/repository/files/README.md" -H "Content-Type: application/json" --data @"$WORK/readme.json" >/dev/null
fi

# ---- 4. the release --------------------------------------------------------------------------
step "Release v$VERSION"
echo "    GET  $PUBLIC/api/v4/projects/$PROJECT_ID/releases/v$VERSION"
if curl -fsS -o /dev/null -H @"$HEADER" "$PUBLIC/api/v4/projects/$PROJECT_ID/releases/v$VERSION" 2>/dev/null; then
  api_send DELETE "/projects/$PROJECT_ID/releases/v$VERSION" >/dev/null
fi
python3 - "$VERSION" "$REGISTRY" "$ZIP" "$DMG" > "$WORK/release.json" <<'PY'
import json, sys
v, registry, zip_name, dmg = sys.argv[1:5]
print(json.dumps({
    "tag_name": f"v{v}", "ref": "main", "name": f"Kestrel {v}",
    "description": f"Kestrel {v} for Macs with Apple Silicon (macOS 12 or later). Signed with Developer ID and notarized.\n\n"
                   "Download Kestrel.dmg, open it, and drag Kestrel to Applications. Installed copies update themselves.",
    "assets": {"links": [
        {"name": "Kestrel.dmg", "url": registry + dmg, "filepath": "/Kestrel.dmg", "link_type": "package"},
        {"name": zip_name, "url": registry + zip_name, "filepath": f"/{zip_name}", "link_type": "package"},
    ]},
}))
PY
api_send POST "/projects/$PROJECT_ID/releases" -H "Content-Type: application/json" --data @"$WORK/release.json" >/dev/null

# ---- 5. the feed -----------------------------------------------------------------------------
step "Feed: latest-mac.yml on main"
node "$ROOT/scripts/release/write-feed.mjs" --dir "$DIR" --version "$VERSION" --base "$REGISTRY" --out "$WORK/latest-mac.yml" >/dev/null
! private_in "$WORK/latest-mac.yml" || fail "the feed contains a private string"
sed 's/^/    /' "$WORK/latest-mac.yml"
python3 -c 'import json,sys; print(json.dumps({"branch":"main","content":open(sys.argv[1]).read(),"commit_message":"Kestrel "+sys.argv[2]}))' "$WORK/latest-mac.yml" "$VERSION" > "$WORK/feed.json"
echo "    GET  $PUBLIC/api/v4/projects/$PROJECT_ID/repository/files/latest-mac.yml?ref=main"
if curl -fsS -o /dev/null -H @"$HEADER" "$PUBLIC/api/v4/projects/$PROJECT_ID/repository/files/latest-mac.yml?ref=main" 2>/dev/null; then
  api_send PUT "/projects/$PROJECT_ID/repository/files/latest-mac.yml" -H "Content-Type: application/json" --data @"$WORK/feed.json" >/dev/null
else
  api_send POST "/projects/$PROJECT_ID/repository/files/latest-mac.yml" -H "Content-Type: application/json" --data @"$WORK/feed.json" >/dev/null
fi

if [ "$DRY" = 1 ]; then
  step "Dry run: nothing was changed"
  exit 0
fi

# ---- 6. verify, as an installed copy and a browser would (no token) -------------------------
step "Verify"
served="$(curl -fsSL "$FEED_URL?nocache=$(date +%s)")" || fail "the public feed does not load: $FEED_URL"
echo "$served" | grep -q "^version: $VERSION$" || fail "the public feed does not say $VERSION yet"
urls="$(echo "$served" | sed -n 's/^ *- url: //p; s/^path: //p' | sort -u)"
for u in $urls "$REGISTRY$ZIP.blockmap" "$PUBLIC/$PROJECT/-/releases/permalink/latest/downloads/Kestrel.dmg"; do
  code="$(curl -sS -o /dev/null -I -L -w '%{http_code}' "$u")"
  [ "$code" = 200 ] || fail "$u answers $code"
  echo "    200  $u"
done
echo
echo "Published Kestrel $VERSION"
echo "    feed:     $FEED_URL"
echo "    download: $PUBLIC/$PROJECT/-/releases/permalink/latest/downloads/Kestrel.dmg"
