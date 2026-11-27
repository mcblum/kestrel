#!/usr/bin/env bash
# Compiles node-pty's native module, pty.node, for Linux on one architecture, for a worker node's bundle.
# node-pty ships prebuilt modules for macOS and Windows only, and a fresh server has no compiler (installing one
# needs an administrator), so the bundle carries one built here (docs/spike-results.md, "Worker nodes").
#
#   scripts/release/node-bundle/build-pty.sh <x64|arm64> <out file>
#
# On Linux of that architecture it is the module pnpm already compiled when it installed node-pty (it needs python3,
# make and g++; the CI image has them), or compiled now. For the other architecture it is cross-compiled with the
# GNU cross compiler for it (g++-aarch64-linux-gnu or g++-x86-64-linux-gnu on Debian) and npm's own node-gyp.
# node-pty uses Node-API, so the module does not depend on the exact Node version it runs on.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ARCH="${1:-}"; OUT="${2:-}"
fail() { echo "!! build-pty: $*" >&2; exit 1; }
case "$ARCH" in x64) TRIPLE=x86_64-linux-gnu; CROSS_PKG=g++-x86-64-linux-gnu ;; arm64) TRIPLE=aarch64-linux-gnu; CROSS_PKG=g++-aarch64-linux-gnu ;; *) fail "usage: build-pty.sh <x64|arm64> <out file>" ;; esac
[ -n "$OUT" ] || fail "usage: build-pty.sh <x64|arm64> <out file>"
[ "$(uname -s)" = Linux ] || fail "pty.node for Linux is compiled on Linux (this is $(uname -s)); in Docker: see DEVELOPMENT.md"

PTY="$(cd "$ROOT/server" && node -p "require('path').dirname(require.resolve('node-pty/package.json'))")"
ADDON="$(cd "$PTY" && node -p "require('path').dirname(require.resolve('node-addon-api/package.json'))")"
HOST_ARCH="$(node -p process.arch)"
mkdir -p "$(dirname "$OUT")"

if [ "$HOST_ARCH" = "$ARCH" ] && [ -f "$PTY/build/Release/pty.node" ]; then
  echo "==> pty.node for linux-$ARCH: the one pnpm compiled ($PTY/build/Release/pty.node)"
  cp "$PTY/build/Release/pty.node" "$OUT"
  exit 0
fi

GYP="$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js"
[ -f "$GYP" ] || fail "npm's node-gyp is not at $GYP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# A copy, so the workspace's own build (for this computer) is not replaced; node-addon-api beside it, as pnpm has it.
mkdir -p "$WORK/node_modules"
cp -R "$PTY" "$WORK/node_modules/node-pty"
cp -R "$ADDON" "$WORK/node_modules/node-addon-api"
rm -rf "$WORK/node_modules/node-pty/build" "$WORK/node_modules/node-pty/prebuilds"

if [ "$HOST_ARCH" = "$ARCH" ]; then
  echo "==> compiling pty.node for linux-$ARCH"
  (cd "$WORK/node_modules/node-pty" && node "$GYP" rebuild --release >/dev/null)
else
  command -v "$TRIPLE-g++" >/dev/null || fail "cross-compiling for linux-$ARCH needs $TRIPLE-g++ (Debian: apt-get install $CROSS_PKG)"
  echo "==> cross-compiling pty.node for linux-$ARCH with $TRIPLE-g++"
  (cd "$WORK/node_modules/node-pty" && CC="$TRIPLE-gcc" CXX="$TRIPLE-g++" LINK="$TRIPLE-g++" AR="$TRIPLE-ar" \
    node "$GYP" rebuild --release --arch="$ARCH" >/dev/null)
fi
cp "$WORK/node_modules/node-pty/build/Release/pty.node" "$OUT"
echo "==> $OUT"
