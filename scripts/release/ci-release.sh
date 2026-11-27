#!/usr/bin/env bash
# What the `release` CI job runs on the Mac runner: build, sign and notarize the Mac app
# (make-release.sh), then publish it (publish.sh). By hand the same two scripts are run one after
# the other.
#
# A release is the Mac app for now. A Windows installer or Linux AppImage of the same version that
# is already in dist/release is published with it (publish.sh picks up what is there); none is
# needed, and CI puts none there. The worker node's Linux bundles are: the package-node-x64 and
# package-node-arm64 jobs leave them in dist/node, and publish.sh publishes them when they are there.
#
# Environment: KESTREL_GITLAB_TOKEN (publish.sh), and make-release.sh's and publish.sh's own.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# The live feeds are asked again by make-release.sh's preflight (release-needed.sh), so a version
# already out stops there too. A beta (1.2.3-beta.4) takes the same path: its channel decides the
# feeds it is compared with and written to (app/release-channel.mjs).
scripts/release/make-release.sh --feeds "${KESTREL_RELEASE_FEEDS:-https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/}"
scripts/release/publish.sh
