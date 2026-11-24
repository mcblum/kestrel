#!/usr/bin/env bash
# Restart the dev app: stop the `pnpm dev:app` running from THIS checkout (if any), wait for it to
# be gone, and start it again in this terminal. Needed after a change to the shell (app/) or the
# server (server/); UI changes hot-reload on their own.
#
#   pnpm dev:restart        (or scripts/dev-restart.sh)
#
# Only the dev app is touched: an installed Kestrel.app is a different program and is left alone.
#
# This is a deliberate restart from a terminal, so it does not ask the app's quit check
# (app/quit-guard.mjs): any agent at work in the dev app is stopped, its turn cut off, and its
# session shows Interrupted until you reply in it. It says so before it stops anything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

# The launcher is `node scripts/dev.mjs` with app/ as its working directory.
running() {
  local pid
  for pid in $(pgrep -f 'node scripts/dev\.mjs' || true); do
    [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$ROOT/app" ] && echo "$pid"
  done
  return 0
}

pids="$(running)"
if [ -n "$pids" ]; then
  echo "==> Stopping the running dev app ($(echo $pids))"
  echo "    Agents at work in it are stopped: each turn is cut off, and the session shows Interrupted until you reply in it."
  echo "    Queued messages are kept, waiting for you to send them. Quit from the app's window instead to be asked first."
  kill -INT $pids 2>/dev/null || true
  for _ in $(seq 50); do [ -z "$(running)" ] && break; sleep 0.2; done
  [ -z "$(running)" ] || { echo "!! the dev app did not stop; quit it and run this again" >&2; exit 1; }
  # The app's own server shuts down after the window; give its port and lock a moment.
  for _ in $(seq 50); do pgrep -f "$ROOT/node_modules/.*/Electron\.app/Contents/MacOS/Electron" >/dev/null || break; sleep 0.2; done
fi

echo "==> Starting the dev app"
cd "$ROOT"
exec pnpm dev:app
