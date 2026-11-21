#!/usr/bin/env bash
# Open Kestrel on the demo workspace: sample projects, sessions, groups, workstreams, pull requests,
# code reviews and settings, with a scripted agent behind "Claude" (no model, no network, nothing
# posted anywhere). For screenshots. It has its own data in ~/.kestrel-demo and its own app state,
# so it runs beside your real Kestrel and never touches it.
#
#   pnpm demo                 open the demo (made on the first run, kept afterwards)
#   pnpm demo --fresh         throw the demo's data away first and make it again
#   pnpm demo --story         the one-moment scene instead: one task across three projects, one
#                             question waiting, the rest folded (its own data, ~/.kestrel-demo-story)
#   pnpm demo --story --reviews   the same scene with two review requests waiting in CODE REVIEWS
#                             (its own data, ~/.kestrel-demo-story-reviews)
#   pnpm demo --light|--dark  force the theme
#
# KESTREL_DEMO_DIR puts the data somewhere else.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
fresh=0
story=0
reviews=0
for arg in "$@"; do
  case "$arg" in
    --fresh) fresh=1 ;;
    --story) story=1 ;;
    --reviews) story=1; reviews=1 ;;
    --light) export KESTREL_APP_THEME=light ;;
    --dark) export KESTREL_APP_THEME=dark ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ "$reviews" = 1 ]; then
  export KESTREL_DEMO_SCENE=story-reviews
  DIR="${KESTREL_DEMO_DIR:-$HOME/.kestrel-demo-story-reviews}"
elif [ "$story" = 1 ]; then
  export KESTREL_DEMO_SCENE=story
  DIR="${KESTREL_DEMO_DIR:-$HOME/.kestrel-demo-story}"
else
  DIR="${KESTREL_DEMO_DIR:-$HOME/.kestrel-demo}"
fi

if [ "$fresh" = 1 ]; then
  # Only ever the demo's own folder: it must be named for the demo and hold nothing but what the demo makes.
  case "$(basename "$DIR")" in
    *kestrel-demo*) ;;
    *) echo "!! refusing to delete $DIR: --fresh only removes a folder whose name contains 'kestrel-demo'" >&2; exit 1 ;;
  esac
  echo "==> Removing $DIR"
  rm -rf "$DIR"
fi

mkdir -p "$DIR"
echo "==> Opening the demo (data in $DIR)"
cd "$ROOT"
KESTREL_DEMO=1 KESTREL_DATA_DIR="$DIR" KESTREL_APP_USER_DATA="$DIR/app" exec pnpm dev:app
