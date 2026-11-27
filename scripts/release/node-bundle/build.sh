#!/usr/bin/env bash
# Builds a worker node's bundle for one architecture, on Linux, from a checkout: what the package-node-* CI jobs
# run, and what a person runs in a Debian container to make one by hand (DEVELOPMENT.md).
#
#   scripts/release/node-bundle/build.sh <x64|arm64> [--version x.y.z]
#
# Same architecture as this computer: pty.node is the one pnpm compiled. The other one: the GNU cross compiler for
# it is installed with apt-get when it is missing (a CI image runs as root; elsewhere install it first), pty.node is
# cross-compiled, and Claude Code's program for it is fetched from npm (fetch-claude-binary.mjs).
# Output: dist/node/kestrel-node-linux-<arch>.tar.gz and its .sha256.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
ARCH="${1:-}"; shift || true
fail() { echo "!! node-bundle: $*" >&2; exit 1; }
case "$ARCH" in x64) CROSS_PKG=g++-x86-64-linux-gnu; TRIPLE=x86_64-linux-gnu ;; arm64) CROSS_PKG=g++-aarch64-linux-gnu; TRIPLE=aarch64-linux-gnu ;; *) fail "usage: build.sh <x64|arm64> [--version x.y.z]" ;; esac
[ "$(uname -s)" = Linux ] || fail "a worker node's bundle is built on Linux (this is $(uname -s))"

if [ "$(node -p process.arch)" != "$ARCH" ]; then
  if ! command -v "$TRIPLE-g++" >/dev/null; then
    [ "$(id -u)" = 0 ] || fail "cross-compiling for $ARCH needs $TRIPLE-g++: apt-get install $CROSS_PKG"
    echo "==> installing $CROSS_PKG"
    apt-get update -qq && apt-get install -y -qq --no-install-recommends "$CROSS_PKG" >/dev/null
  fi
  node scripts/release/fetch-claude-binary.mjs --platform linux --arch "$ARCH"
fi
scripts/release/node-bundle/build-pty.sh "$ARCH" "dist/node-pty/linux-$ARCH/pty.node"
node scripts/release/node-bundle/make-node-bundle.mjs --arch "$ARCH" --pty "dist/node-pty/linux-$ARCH/pty.node" "$@"
