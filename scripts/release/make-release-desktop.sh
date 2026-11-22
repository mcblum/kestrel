#!/usr/bin/env bash
# Builds Kestrel for Windows or Linux, in one go, beside the Mac build make-release.sh makes:
#
#   install -> UI -> (Windows, off Windows: fetch its Claude Code binary) -> stage -> package
#   (electron-builder) -> update feed -> dist/release
#
#   scripts/release/make-release-desktop.sh --platform linux|windows [--allow-dirty] [--version x.y.z]
#                                           [--no-exe-edit]
#
#   --platform linux    an AppImage for this computer's architecture. Run on Linux: node-pty has no
#                       Linux prebuild and is compiled where it is installed (python3, make, g++).
#   --platform windows  the NSIS installer for x64. Run on Windows, or on Linux or a Mac with wine
#                       on PATH (electron-builder writes the icon and version into Kestrel.exe with it).
#   --allow-dirty       build with uncommitted changes (test builds only)
#   --version           put this version in the build instead of app/package.json's (updater tests only)
#   --no-exe-edit       Windows only: leave Kestrel.exe's icon and version as Electron's, so no wine
#                       is needed. For checking the packaging on a Mac; never for a release.
#
# Neither build is code-signed: there is no Windows certificate, and an AppImage carries none.
# Output, in dist/release: the installer or AppImage, its blockmap where there is one, and the feed
# (latest.yml for Windows, latest-linux.yml for Linux; relative URLs, publish.sh rewrites them).
# Nothing is uploaded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="$ROOT/dist/release"
BUILDER_OUT="$ROOT/dist/builder"

TARGET=""; ALLOW_DIRTY=0; VERSION_OVERRIDE=""; NO_EXE_EDIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) TARGET="${2:?--platform needs linux or windows}"; shift ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --version) VERSION_OVERRIDE="${2:?--version needs x.y.z}"; shift ;;
    --no-exe-edit) NO_EXE_EDIT=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "!! unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
fail() { echo "!! make-release-desktop: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

HOST_OS="$(node -p process.platform)"
HOST_ARCH="$(node -p process.arch)"
case "$TARGET" in
  linux)
    [ "$HOST_OS" = linux ] || fail "a Linux build is made on Linux: node-pty is compiled for the computer it is installed on (this is $HOST_OS)"
    NODE_OS=linux; ARCH="$HOST_ARCH"; FEED_PLATFORM=linux; BUILDER_FLAG=--linux ;;
  windows)
    NODE_OS=win32; ARCH=x64; FEED_PLATFORM=win; BUILDER_FLAG=--win
    if [ "$HOST_OS" != win32 ] && [ "$NO_EXE_EDIT" != 1 ]; then
      command -v wine >/dev/null 2>&1 || fail "building the Windows installer off Windows needs wine on PATH (or --no-exe-edit for a packaging check)"
    fi ;;
  *) fail "--platform is linux or windows (the Mac build is scripts/release/make-release.sh)" ;;
esac
VERSION="${VERSION_OVERRIDE:-$(node -p "require('./app/package.json').version")}"

# Tracked files only: untracked scratch folders never reach the build.
if [ "$ALLOW_DIRTY" != 1 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  fail "the working tree has uncommitted changes (commit them, or --allow-dirty for a test build)"
fi

step "Install"
pnpm install --frozen-lockfile

step "UI"
pnpm --filter @kestrel/ui build

if [ "$NODE_OS" != "$HOST_OS" ] || [ "$ARCH" != "$HOST_ARCH" ]; then
  step "Claude Code binary for $NODE_OS-$ARCH"
  node scripts/release/fetch-claude-binary.mjs --platform "$NODE_OS" --arch "$ARCH"
fi

step "Stage (server bundle, node-pty, Claude Code binary)"
KESTREL_VERSION_OVERRIDE="$VERSION_OVERRIDE" node app/scripts/package/stage.mjs --platform "$NODE_OS" --arch "$ARCH"

step "Package Kestrel $VERSION for $TARGET ($ARCH)"
rm -rf "$BUILDER_OUT"
KESTREL_TARGET_PLATFORM="$NODE_OS" KESTREL_WIN_NO_EDIT="$NO_EXE_EDIT" app/node_modules/.bin/electron-builder "$BUILDER_FLAG" "--$ARCH" --publish never \
  --config "$ROOT/app/electron-builder.config.cjs" --projectDir "$ROOT/dist/stage/app"

step "Collect into dist/release"
mkdir -p "$OUT"
NAMES="$(node --input-type=module -e "
  import { feedFiles } from './scripts/release/feed-files.mjs';
  const n = feedFiles('$FEED_PLATFORM', '$ARCH', '$VERSION');
  console.log([...n.files, ...n.blockmaps].join('\n'));
")"
while IFS= read -r name; do
  [ -f "$BUILDER_OUT/$name" ] || fail "electron-builder did not make $name"
  cp "$BUILDER_OUT/$name" "$OUT/"
done <<< "$NAMES"
node scripts/release/write-feed.mjs --dir "$OUT" --version "$VERSION" --platform "$FEED_PLATFORM" --arch "$ARCH"

step "Kestrel $VERSION for $TARGET"
( cd "$OUT" && ls -lh | sed 1d | awk '{print "    " $5 "\t" $9}' )
echo "    Not code-signed. Publishing is a separate, approved step: scripts/release/publish.sh (see RELEASING.md)."
