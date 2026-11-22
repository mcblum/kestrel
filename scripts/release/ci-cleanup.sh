#!/usr/bin/env bash
# Run by the `release` CI job when it ends, passed or failed: removes from the checkout what a
# release build leaves behind and nothing needs again. The runner's disk is shared and small.
#
# Kept: dist/release (the job's artifact is uploaded after this runs). Kept too, outside the
# checkout: pnpm's store and Electron's download caches, which make the next release quick.
# Never fails the job: a release that worked must not go red over tidying.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 0
before="$(df -k . | awk 'NR==2 {print $4}')"
for path in dist/builder dist/stage dist/cache dist/builder-win-check node_modules app/node_modules server/node_modules ui/node_modules spike/node_modules ui/dist app/native/build; do
  # Only ever inside this checkout, and only these names.
  [ -e "$ROOT/$path" ] && rm -rf "${ROOT:?}/$path"
done
after="$(df -k . | awk 'NR==2 {print $4}')"
echo "==> cleaned up after the release: $(( (after - before) / 1024 )) MB freed, $(( after / 1048576 )) GB free on this disk"
exit 0
