#!/usr/bin/env bash
# Publishes the release make-release.sh left in dist/release to the public kestrel/releases
# project on starfish, with the Windows installer and the Linux AppImage of the same version when
# they are in that folder too (make-release-desktop.sh, or a CI job's artifacts copied in). The Mac
# build is always there: a release is never Windows or Linux alone. House pattern (Shrike Packaging/gitlab-release.sh, Bellbird
# scripts/publish-macos.sh), with electron-updater's feed in place of Sparkle's appcast:
#
#   1. checks  the DMG and the app in the zip are signed, notarized and stapled; nothing in the
#              artifacts carries a local home path, the owner's email or a token
#   2. feed    the live feed's version must be older than this one (--force to replace it)
#   3. upload  zip, zip blockmap and DMG to the generic package registry, package `kestrel`,
#              version <v> (replacing that version's files if they are already there)
#   4. release GitLab Release v<v> with asset links; the DMG link's filepath is /Kestrel.dmg so
#              …/-/releases/permalink/latest/downloads/Kestrel.dmg is the download. Its notes are
#              whats-new/<v>.md, the app's own What's new page (release-notes.mjs); a release
#              without that file stops before anything is sent
#   5. feed    latest-mac.yml, with absolute URLs into the package registry, committed to `main`
#              (last, so the feed never names a file that is not there yet)
#   6. verify  fetch the public feed and HEAD every URL in it, the blockmap and the permalink
#
# The version's channel (app/release-channel.mjs, through version.mjs) decides what is published:
#
#   1.2.3          a release, as above. Its feed is also committed as beta-mac.yml, so copies on the
#                  beta channel move to it, unless the beta feed already serves a newer beta.
#   1.2.3-beta.4   a beta: steps 1, 2, 3 and 6 as above, then only beta-mac.yml is committed. No
#                  Release is made (it would move the permanent download link to the beta), so
#                  latest-mac.yml, Kestrel.dmg's link and the release notes stay exactly as they
#                  were. The beta DMG's own address in the package registry is printed at the end:
#                  that is how the first beta is installed on a copy that has no beta switch.
#
# Windows and Linux ride along through the same steps: their files are uploaded in 3, linked from
# the Release in 4 (/Kestrel-Setup.exe and /Kestrel.AppImage are their permanent downloads), and
# their feeds (latest.yml, latest-linux.yml) are committed in 5. They are not code-signed, so step 1
# checks only their names and feeds for private strings and that their feed says this version.
#
# So do the worker node's bundles (kestrel-node-linux-<arch>.tar.gz and .sha256, from dist/node, where the
# package-node-* CI jobs leave them): step 1 checks each against its checksum, that it holds this version, and that
# nothing private is inside; 3 uploads them; 4 links them from a release's Release (/kestrel-node-linux-<arch>.tar.gz);
# 5 commits the node's install script to `main` with this version written into it (KESTREL_LATEST) and its channel:
# a beta as install-beta.sh, a release as install.sh and, when the betas move to it (as beta-mac.yml does),
# install-beta.sh too. Each is a one-line install, `curl -fsSL …/-/raw/main/install[-beta].sh | sh`, which
# fetches the version it names from the package registry. Only a publish that carries the bundles writes them, so
# the version an install script names always has its bundles. None is required: without them the rest is published.
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
#   KESTREL_NODE_DIR          where the worker node's bundles are; default dist/node
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${GITLAB_HOST:-starfish.nationalmachine.io}"
PUBLIC="https://$HOST"
PROJECT="${KESTREL_RELEASES_PROJECT:-kestrel/releases}"
PACKAGE="kestrel"
UPLOAD="${GITLAB_UPLOAD_HOST:-$PUBLIC}"
DIR="$ROOT/dist/release"
NODE_DIR="${KESTREL_NODE_DIR:-$ROOT/dist/node}"
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

# Every Mac build writes beta-mac.yml (a release writes latest-mac.yml beside it); a folder made
# before there was a beta channel has latest-mac.yml alone.
MAC_FEED="$DIR/beta-mac.yml"; [ -f "$MAC_FEED" ] || MAC_FEED="$DIR/latest-mac.yml"
VERSION="$(sed -n 's/^version: *//p' "$MAC_FEED" 2>/dev/null | head -1)"
[ -n "$VERSION" ] || fail "no release in $DIR (run scripts/release/make-release.sh)"
CHANNEL="$(node "$ROOT/scripts/release/version.mjs" channel "$VERSION")" || fail "$MAC_FEED says $VERSION, which cannot be published"
ZIP="Kestrel-$VERSION-arm64-mac.zip"
DMG="Kestrel-$VERSION-arm64.dmg"
for f in "$ZIP" "$ZIP.blockmap" "$DMG"; do [ -f "$DIR/$f" ] || fail "missing $DIR/$f"; done
if [ "$CHANNEL" = stable ]; then
  [ "$(sed -n 's/^version: *//p' "$DIR/latest-mac.yml" 2>/dev/null | head -1)" = "$VERSION" ] || fail "latest-mac.yml in $DIR does not say $VERSION"
  [ -f "$DIR/Kestrel.dmg" ] || fail "missing $DIR/Kestrel.dmg"
  cmp -s "$DIR/$DMG" "$DIR/Kestrel.dmg" || fail "Kestrel.dmg is not the same file as $DMG"
fi

# The other platforms' builds of this version, when they are here. Each line of OTHERS is
# "<platform> <arch> <feed file> <artifact> <permanent download name>".
OTHERS=""
other() { # platform arch feed artifact permalink
  [ -f "$DIR/$4" ] || return 0
  [ -f "$DIR/$3" ] || fail "$4 is here without its feed $3 (run scripts/release/make-release-desktop.sh)"
  local said; said="$(sed -n 's/^version: *//p' "$DIR/$3" | head -1)"
  [ "$said" = "$VERSION" ] || fail "$3 says ${said:-nothing}, the Mac feed says $VERSION"
  grep -q "url: $4$" "$DIR/$3" || fail "$3 does not name $4"
  OTHERS="$OTHERS$1 $2 $3 $4 $5"$'\n'
}
feed_of() { node "$ROOT/scripts/release/version.mjs" feed "$VERSION" "$1" "$2"; }
other win x64 "$(feed_of win x64)" "Kestrel-Setup-$VERSION-x64.exe" Kestrel-Setup.exe
other linux x64 "$(feed_of linux x64)" "Kestrel-$VERSION-x86_64.AppImage" Kestrel.AppImage
other linux arm64 "$(feed_of linux arm64)" "Kestrel-$VERSION-arm64.AppImage" Kestrel-arm64.AppImage
OTHER_FILES=""
while read -r _ _ feed artifact _; do
  [ -n "${artifact:-}" ] || continue
  OTHER_FILES="$OTHER_FILES $artifact"
  [ ! -f "$DIR/$artifact.blockmap" ] || OTHER_FILES="$OTHER_FILES $artifact.blockmap"
done <<< "$OTHERS"

# The worker node's bundles of this version, by architecture, when they are here.
NODE_ARCHES=""
NODE_FILES=""
for arch in x64 arm64; do
  f="kestrel-node-linux-$arch.tar.gz"
  [ -f "$NODE_DIR/$f" ] || continue
  [ -f "$NODE_DIR/$f.sha256" ] || fail "$f is here without its checksum $f.sha256 (scripts/release/node-bundle/build.sh)"
  NODE_ARCHES="$NODE_ARCHES $arch"
  NODE_FILES="$NODE_FILES $f $f.sha256"
done
# Where a file to upload is: the node's bundles in NODE_DIR, everything else in DIR.
source_of() { case "$1" in kestrel-node-*) echo "$NODE_DIR/$1" ;; *) echo "$DIR/$1" ;; esac; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The release's notes on the host are whats-new/<version>.md, the same file the app shows (release-notes.mjs).
# Read before anything is sent, so a release without them stops here.
NOTES_BODY=""
if [ "$CHANNEL" = stable ]; then
  said="$(node "$ROOT/scripts/release/release-notes.mjs" check "$VERSION" 2>&1)" || fail "${said#!! }"
  node "$ROOT/scripts/release/release-notes.mjs" body "$VERSION" > "$WORK/notes.md" || fail "could not read the notes of $VERSION"
  NOTES_BODY="$WORK/notes.md"
fi

# ---- 1. checks ------------------------------------------------------------------------------
step "Check Kestrel $VERSION ($CHANNEL): notarized, stapled, nothing private inside"
xcrun stapler validate "$DIR/$DMG" >/dev/null || fail "the DMG has no stapled notarization ticket"
spctl -a -t open --context context:primary-signature "$DIR/$DMG" 2>/dev/null || fail "Gatekeeper rejects the DMG"
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
for f in "$DIR/latest-mac.yml" "$DIR/beta-mac.yml"; do [ ! -f "$f" ] || ! private_in "$f" || fail "${f##*/} contains a private string"; done
hits="$( { grep -rlaF -f "$PRIVATE" "$APP"; grep -rlaE "$TOKEN_SHAPE" "$APP"; } 2>/dev/null | sed "s|$WORK/zip/||" | sort -u | head -5 || true)"
[ -z "$hits" ] || { echo "$hits" >&2; fail "files in the app contain a private string (listed above)"; }
echo "    no home path, email or token in the zip's names, the app's files or the feed"
while read -r platform arch feed artifact _; do
  [ -n "${artifact:-}" ] || continue
  ! private_in "$DIR/$feed" || fail "$feed contains a private string"
  echo "    also publishing $artifact ($platform $arch; not code-signed, its contents are not opened here)"
done <<< "$OTHERS"
[ -n "$OTHERS" ] || echo "    no Windows or Linux build of $VERSION in $DIR: publishing the Mac build alone"
for arch in x64 arm64; do
  f="kestrel-node-linux-$arch.tar.gz"
  case " $NODE_ARCHES " in *" $arch "*) ;; *) echo "    no worker node bundle for linux-$arch in $NODE_DIR: not published"; continue ;; esac
  grep -q "^[0-9a-f]\{64\}  $f\$" "$NODE_DIR/$f.sha256" || fail "$f.sha256 is not one checksum line for $f"
  [ "$(cut -d' ' -f1 "$NODE_DIR/$f.sha256")" = "$(shasum -a 256 "$NODE_DIR/$f" | cut -d' ' -f1)" ] || fail "$f does not match its checksum"
  mkdir -p "$WORK/node-$arch"
  tar -xzf "$NODE_DIR/$f" -C "$WORK/node-$arch" || fail "$f does not unpack"
  said="$(tr -d '[:space:]' < "$WORK/node-$arch/VERSION" 2>/dev/null || true)"
  [ "$said" = "$VERSION" ] || fail "$f holds ${said:-no version}, the Mac feed says $VERSION"
  hits="$( { grep -rlaF -f "$PRIVATE" "$WORK/node-$arch"; grep -rlaE "$TOKEN_SHAPE" "$WORK/node-$arch"; } 2>/dev/null | sed "s|$WORK/||" | sort -u | head -5 || true)"
  [ -z "$hits" ] || { echo "$hits" >&2; fail "files in $f contain a private string (listed above)"; }
  rm -rf "$WORK/node-$arch"
  echo "    also publishing $f (worker node, linux $arch; checksum and version checked, nothing private inside)"
done

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
RAW="$PUBLIC/$PROJECT/-/raw/main/"
MAC_FEED_NAME="$(feed_of mac arm64)"
FEED_URL="$RAW$MAC_FEED_NAME"

# ---- 2. the live feeds -----------------------------------------------------------------------
# The same question CI asks (release-needed.sh): a release against latest-mac.yml, a beta against
# latest-mac.yml and beta-mac.yml both.
step "Live feeds"
echo "    GET  ${RAW}latest-mac.yml, ${RAW}beta-mac.yml (public, no token)"
due=0; said="$("$ROOT/scripts/release/release-needed.sh" --feeds "$RAW" --version "$VERSION" 2>&1)" || due=$?
case "$due" in
  0) echo "    $said" ;;
  1) [ "$FORCE" = 1 ] || fail "$said (--force replaces it)"; echo "    $said; publishing $VERSION anyway (--force)" ;;
  *) fail "$said" ;;
esac
# What the beta feed serves now: a release is written there too unless a newer beta is already there.
LIVE_BETA="$(curl -fsSL "${RAW}beta-mac.yml?nocache=$(date +%s)" 2>/dev/null | sed -n 's/^version: *//p' | head -1 | tr -d "'\"\r " || true)"

# ---- 3. upload -------------------------------------------------------------------------------
step "Upload to the package registry ($PACKAGE $VERSION)"
existing="$(api_get "/projects/$PROJECT_ID/packages?package_type=generic&package_name=$PACKAGE&package_version=$VERSION" | json '" ".join(str(p["id"]) for p in d if p.get("version")==sys.argv[1] and p.get("name")==sys.argv[2])' "$VERSION" "$PACKAGE" 2>/dev/null || true)"
for id in $existing; do api_send DELETE "/projects/$PROJECT_ID/packages/$id" >/dev/null; done
UPLOAD_ARGS=()
# The direct upload route (the GitLab box itself) needs the public name; the public route must not get one.
[ "$UPLOAD" = "$PUBLIC" ] || UPLOAD_ARGS=(--http1.1 -H "Host: $HOST")
for f in "$ZIP" "$ZIP.blockmap" "$DMG" $OTHER_FILES $NODE_FILES; do
  path="/projects/$PROJECT_ID/packages/generic/$PACKAGE/$VERSION/$f"
  if [ "$DRY" = 1 ]; then echo "    (dry run) PUT $UPLOAD/api/v4$path  <- $f ($(du -h "$(source_of "$f")" | cut -f1))"; continue; fi
  echo "    PUT  $UPLOAD/api/v4$path" >&2
  curl -fsS --max-time 1800 -X PUT -H @"$HEADER" "${UPLOAD_ARGS[@]+"${UPLOAD_ARGS[@]}"}" --upload-file "$(source_of "$f")" "$UPLOAD/api/v4$path" >/dev/null \
    || fail "uploading $f failed"
done

# A Release hangs its tag on a ref: an empty project gets a first commit on main.
if [ -z "$DEFAULT_BRANCH" ]; then
  readme="$(printf '# Kestrel releases\n\nDownloads and the update feeds for Kestrel.\n\n- Download: %s/%s/-/releases/permalink/latest/downloads/Kestrel.dmg\n- Update feed: %s\n' "$PUBLIC" "$PROJECT" "${RAW}latest-mac.yml")"
  python3 -c 'import json,sys; print(json.dumps({"branch":"main","content":sys.argv[1],"commit_message":"Kestrel releases"}))' "$readme" > "$WORK/readme.json"
  api_send POST "/projects/$PROJECT_ID/repository/files/README.md" -H "Content-Type: application/json" --data @"$WORK/readme.json" >/dev/null
fi

# ---- 4. the release --------------------------------------------------------------------------
if [ "$CHANNEL" = beta ]; then
  step "No Release for a beta"
  echo "    a GitLab Release would move the permanent download link; ${MAC_FEED_NAME} is the only thing that changes"
else
step "Release v$VERSION"
echo "    GET  $PUBLIC/api/v4/projects/$PROJECT_ID/releases/v$VERSION"
if curl -fsS -o /dev/null -H @"$HEADER" "$PUBLIC/api/v4/projects/$PROJECT_ID/releases/v$VERSION" 2>/dev/null; then
  api_send DELETE "/projects/$PROJECT_ID/releases/v$VERSION" >/dev/null
fi
printf '%s' "$OTHERS" > "$WORK/others"
python3 - "$VERSION" "$REGISTRY" "$ZIP" "$DMG" "$WORK/others" "$NOTES_BODY" "$NODE_ARCHES" "${RAW}install.sh" > "$WORK/release.json" <<'PY'
import json, sys
v, registry, zip_name, dmg, others, notes, node_arches, installer = sys.argv[1:9]
links = [
    {"name": "Kestrel.dmg", "url": registry + dmg, "filepath": "/Kestrel.dmg", "link_type": "package"},
    {"name": zip_name, "url": registry + zip_name, "filepath": f"/{zip_name}", "link_type": "package"},
]
text = [open(notes).read().strip(), "## Download"] if notes else [f"Kestrel {v}."]
text += ["**Mac** (Apple Silicon, macOS 12 or later): download Kestrel.dmg, open it, and drag Kestrel to Applications. Signed with Developer ID and notarized."]
for line in open(others).read().splitlines():
    platform, arch, _feed, artifact, permalink = line.split()
    links.append({"name": permalink, "url": registry + artifact, "filepath": f"/{permalink}", "link_type": "package"})
    if platform == "win":
        text.append(f"**Windows** ({arch}): download and run {permalink}. It is not code-signed yet, so Windows SmartScreen asks before it runs.")
    else:
        text.append(f"**Linux** ({arch}): download {permalink}, make it executable (`chmod +x`) and run it. It needs FUSE 2 (libfuse2) as every AppImage does.")
node_arches = node_arches.split()
for arch in node_arches:
    for name in (f"kestrel-node-linux-{arch}.tar.gz", f"kestrel-node-linux-{arch}.tar.gz.sha256"):
        links.append({"name": name, "url": registry + name, "filepath": f"/{name}", "link_type": "package"})
if node_arches:
    text.append(f"**Linux worker node** ({', '.join(node_arches)}): on the server, as the user it will run as, `curl -fsSL {installer} | sh`. It needs no administrator; the bundles and their checksums are below.")
text.append("Installed copies update themselves.")
print(json.dumps({"tag_name": f"v{v}", "ref": "main", "name": f"Kestrel {v}", "description": "\n\n".join(text), "assets": {"links": links}}))
PY
api_send POST "/projects/$PROJECT_ID/releases" -H "Content-Type: application/json" --data @"$WORK/release.json" >/dev/null
fi

# ---- 5. the feeds ----------------------------------------------------------------------------
step "Feeds on main"
COMMITTED=""
commit_file() { # name local-file: committed to main of the releases project as <name>
  local name="$1" file="$2"
  python3 -c 'import json,sys; print(json.dumps({"branch":"main","content":open(sys.argv[1]).read(),"commit_message":"Kestrel "+sys.argv[2]+" ("+sys.argv[3]+")"}))' "$file" "$VERSION" "$name" > "$WORK/feed.json"
  echo "    GET  $PUBLIC/api/v4/projects/$PROJECT_ID/repository/files/$name?ref=main"
  if curl -fsS -o /dev/null -H @"$HEADER" "$PUBLIC/api/v4/projects/$PROJECT_ID/repository/files/$name?ref=main" 2>/dev/null; then
    api_send PUT "/projects/$PROJECT_ID/repository/files/$name" -H "Content-Type: application/json" --data @"$WORK/feed.json" >/dev/null
  else
    api_send POST "/projects/$PROJECT_ID/repository/files/$name" -H "Content-Type: application/json" --data @"$WORK/feed.json" >/dev/null
  fi
}
commit_feed() { # platform arch feed-file-name
  local platform="$1" arch="$2" name="$3"
  node "$ROOT/scripts/release/write-feed.mjs" --dir "$DIR" --version "$VERSION" --platform "$platform" --arch "$arch" --base "$REGISTRY" --out "$WORK/$name" >/dev/null
  ! private_in "$WORK/$name" || fail "$name contains a private string"
  echo "    $name:"; sed 's/^/      /' "$WORK/$name"
  commit_file "$name" "$WORK/$name"
  COMMITTED="$COMMITTED $name"
}
# Each platform's feeds, from the channel rule: a beta's beta feed; a release's own feed, then its
# beta twin unless the beta feed serves a newer beta (version.mjs feeds).
commit_feeds() { # platform arch
  local name
  for name in $(node "$ROOT/scripts/release/version.mjs" feeds "$VERSION" "$LIVE_BETA" "$1" "$2"); do commit_feed "$1" "$2" "$name"; done
}
if [ "$CHANNEL" = stable ] && ! node "$ROOT/scripts/release/version.mjs" feeds "$VERSION" "$LIVE_BETA" | grep -qx beta-mac.yml; then
  echo "    the beta feed serves $LIVE_BETA, newer than $VERSION: beta copies keep it, and its feed is left alone"
fi
commit_feeds mac arm64
while read -r platform arch feed _ _; do
  [ -n "${feed:-}" ] || continue
  commit_feeds "$platform" "$arch"
done <<< "$OTHERS"
# The worker node's install scripts, beside the feeds, where their one-line commands fetch them. Each names the newest
# version of its channel, written in here, so the copy served is the feed: a beta writes install-beta.sh; a
# release writes install.sh, and install-beta.sh too unless the betas serve a newer beta (the beta-mac.yml
# rule, version.mjs feeds).
INSTALLERS=""
if [ -n "$NODE_ARCHES" ]; then
  [ "$CHANNEL" != stable ] || INSTALLERS="install.sh"
  if [ "$CHANNEL" = beta ] || node "$ROOT/scripts/release/version.mjs" feeds "$VERSION" "$LIVE_BETA" | grep -qx beta-mac.yml; then INSTALLERS="$INSTALLERS install-beta.sh"; fi
  for name in $INSTALLERS; do
    case "$name" in *-beta.sh) ch=beta ;; *) ch=stable ;; esac
    sed -e "s/^KESTREL_CHANNEL=.*/KESTREL_CHANNEL=$ch/" -e "s/^KESTREL_LATEST=.*/KESTREL_LATEST=$VERSION/" "$ROOT/scripts/release/install.sh" > "$WORK/$name"
    { grep -qx "KESTREL_CHANNEL=$ch" "$WORK/$name" && grep -qx "KESTREL_LATEST=$VERSION" "$WORK/$name"; } || fail "could not write $ch and $VERSION into $name"
    ! private_in "$WORK/$name" || fail "$name contains a private string"
    echo "    $name (the worker node's install for the ${ch} channel, naming $VERSION, for linux:$NODE_ARCHES)"
    commit_file "$name" "$WORK/$name"
  done
fi

if [ "$DRY" = 1 ]; then
  step "Dry run: nothing was changed"
  exit 0
fi

# ---- 6. verify, as an installed copy and a browser would (no token) -------------------------
step "Verify"
urls=""
for name in $COMMITTED; do
  served="$(curl -fsSL "$RAW$name?nocache=$(date +%s)")" || fail "the public feed does not load: $RAW$name"
  echo "$served" | grep -q "^version: $VERSION$" || fail "the public $name does not say $VERSION yet"
  urls="$urls $(echo "$served" | sed -n 's/^ *- url: //p; s/^path: //p' | sort -u)"
done
permalinks=""
if [ "$CHANNEL" = stable ]; then
  permalinks="$PUBLIC/$PROJECT/-/releases/permalink/latest/downloads/Kestrel.dmg"
  while read -r _ _ feed _ permalink; do
    [ -n "${feed:-}" ] || continue
    permalinks="$permalinks $PUBLIC/$PROJECT/-/releases/permalink/latest/downloads/$permalink"
  done <<< "$OTHERS"
  for f in $NODE_FILES; do permalinks="$permalinks $PUBLIC/$PROJECT/-/releases/permalink/latest/downloads/$f"; done
fi
# Each install script as the one-line command fetches it, naming this version, and the bundles it will fetch.
for name in $INSTALLERS; do
  served="$(curl -fsSL "$RAW$name?nocache=$(date +%s)")" || fail "the public install script does not load: $RAW$name"
  echo "$served" | grep -qx "KESTREL_LATEST=$VERSION" || fail "the public $name does not name $VERSION yet"
  echo "    200  $RAW$name (names $VERSION)"
done
for f in $NODE_FILES; do urls="$urls $REGISTRY$f"; done
for u in $(printf '%s\n' $urls | sort -u) "$REGISTRY$ZIP.blockmap" $permalinks; do
  code="$(curl -sS -o /dev/null -I -L -w '%{http_code}' "$u")"
  [ "$code" = 200 ] || fail "$u answers $code"
  echo "    200  $u"
done
echo
if [ "$CHANNEL" = beta ]; then
  echo "Published Kestrel $VERSION to the beta channel only"
  echo "    feed:     $RAW$MAC_FEED_NAME"
  echo "    download: $REGISTRY$DMG"
  echo "    (install it by hand once on a copy without the beta switch; it comes up on the beta channel)"
  echo "    latest-mac.yml, the permanent download link and the release notes are unchanged."
  for name in $INSTALLERS; do echo "    worker node (beta): curl -fsSL $RAW$name | sh"; done
else
  echo "Published Kestrel $VERSION"
  for name in $COMMITTED; do echo "    feed:     $RAW$name"; done
  for u in $permalinks; do echo "    download: $u"; done
  for name in $INSTALLERS; do echo "    worker node$(case "$name" in *-beta.sh) echo ' (beta)' ;; esac): curl -fsSL $RAW$name | sh"; done
fi
