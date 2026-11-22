#!/usr/bin/env bash
# What the `release` CI job runs on the Mac runner: build, sign and notarize the Mac app
# (make-release.sh), then publish it (publish.sh). By hand the same two scripts are run one after
# the other.
#
# A release is the Mac app for now. A Windows installer or Linux AppImage of the same version that
# is already in dist/release is published with it (publish.sh picks up what is there); none is
# needed, and CI puts none there.
#
# Environment: KESTREL_GITLAB_TOKEN (publish.sh), and make-release.sh's and publish.sh's own.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# The live feed is asked again by make-release.sh's preflight, so a version already out stops there too.
scripts/release/make-release.sh --feed "${KESTREL_RELEASE_FEED:-https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/latest-mac.yml}"
scripts/release/publish.sh
