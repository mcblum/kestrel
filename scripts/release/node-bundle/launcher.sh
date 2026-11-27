#!/bin/sh
# kestrel-node: the worker node's launcher, written into each bundle by make-node-bundle.mjs and linked onto PATH as
# `kestrel` (and `kestrel-node`). The service (kestrel-node.service) and every command typed in a terminal come
# through here, so they agree on where Kestrel's data is and which version this is.
set -eu
self="$(readlink -f -- "$0")"
root="$(cd -- "$(dirname -- "$self")/.." && pwd -P)"
# The bundle's own Node first: the agents' npm launchers (codex, opencode) start with "#!/usr/bin/env node", and a
# server often has no Node of its own.
PATH="$root/node/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
# An installed copy, as the app's shell says so: Kestrel's folder is ~/.kestrel and crash reports go out
# (server/src/data-dir.ts, crash-reports); the version names this release.
KESTREL_PACKAGED=1
KESTREL_APP_VERSION="$(cat -- "$root/VERSION")"
# The Claude Code program the Agent SDK runs, from its per-platform package in the bundle.
KESTREL_CLAUDE_EXECUTABLE="$root/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-@ARCH@/claude"
export PATH KESTREL_PACKAGED KESTREL_APP_VERSION KESTREL_CLAUDE_EXECUTABLE
exec "$root/node/bin/node" "$root/server/kestrel-node.mjs" "$@"
