#!/bin/sh
# Installs a Kestrel worker node for the user who runs it, on Linux (x86_64 or aarch64), with no administrator:
#
#   curl -fsSL https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/install-node.sh | sh
#
# or, downloaded:  sh install-node.sh [version]       (a version, 1.2.3 or 1.2.3-beta.4; default: the newest release)
# Through a pipe the version goes after "sh -s --":  curl -fsSL … | sh -s -- 0.0.34
#
# What it does: fetches the bundle for this processor over HTTPS with its checksum, and checks the checksum before
# anything is unpacked (a mismatch stops it, leaving nothing behind); unpacks it into ~/.kestrel/node/<version>/ with
# a `current` link; makes ~/.kestrel the user's alone (mode 700: it holds the sessions' conversations); links
# kestrel-node into ~/.local/bin; writes a systemd --user unit and starts it; then says what to do next
# (kestrel-node join, then kestrel-node agents). Run again, it upgrades in place: Kestrel's data in ~/.kestrel is left
# as it is, and it says only the steps the running node has not done yet.
#
# Two things only an administrator can do, which it says instead of doing: turning on lingering (so the node runs
# with nobody logged in and starts after a reboot), and installing bubblewrap and socat (the command sandbox).
#
# Environment, for trying a bundle before it is published (DEVELOPMENT.md): KESTREL_NODE_URL, a folder or address
# holding kestrel-node-linux-<arch>.tar.gz and its .sha256 (file:///… works); KESTREL_NODE_VERSION, the version;
# KESTREL_NODE_START_WAIT, how many seconds to wait for the service to answer (default 20).
set -eu

RELEASES="https://starfish.nationalmachine.io/kestrel/releases"
REGISTRY="https://starfish.nationalmachine.io/api/v4/projects/kestrel%2Freleases/packages/generic/kestrel"
UNIT=kestrel-node.service

say() { printf '%s\n' "$*"; }
refuse() { printf 'Kestrel worker node: %s\n' "$*" >&2; exit 1; }

# ---- where this is ------------------------------------------------------------------------------
system="$(uname -s)"
[ "$system" = Linux ] || refuse "A Kestrel worker node runs on Linux; this is $system. On a Mac or Windows, install the Kestrel app."
[ "$(id -u)" != 0 ] || refuse "Run this as the user the node will run as, not as root (or with sudo): it installs into that user's home folder and needs no administrator."
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) refuse "There is no Kestrel worker node for this processor ($machine). It is built for x86_64 and aarch64 (arm64)." ;;
esac
if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
  refuse "This system's C library is musl (Alpine and the like). The worker node's Node runtime needs glibc (Debian, Ubuntu, Fedora, Arch and most others)."
fi
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || refuse "HOME is not set to a folder, so there is nowhere to install."
USER_NAME="$(id -un)"

VERSION="${1:-${KESTREL_NODE_VERSION:-}}"
if [ -n "$VERSION" ] && ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'; then
  refuse "\"$VERSION\" is not a version: give one like 0.0.34 or 0.0.34-beta.1, or none for the newest release."
fi

FILE="kestrel-node-linux-$ARCH.tar.gz"
if [ -n "${KESTREL_NODE_URL:-}" ]; then
  BASE="${KESTREL_NODE_URL%/}"
elif [ -n "$VERSION" ]; then
  BASE="$REGISTRY/$VERSION"
else
  BASE="$RELEASES/-/releases/permalink/latest/downloads"
fi

# ---- fetch and check, before anything is written --------------------------------------------------
fetch() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in https://*) wget -q -O "$2" "$1" ;; *) refuse "wget fetches only https addresses; install curl to fetch $1" ;; esac
  else
    refuse "Neither curl nor wget is here to fetch the bundle."
  fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else refuse "Neither sha256sum nor shasum is here to check the bundle's checksum."
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/kestrel-node.XXXXXX")"
INCOMING=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$INCOMING" ] || rm -rf "$INCOMING"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "Fetching $FILE${VERSION:+ ($VERSION)} from $BASE"
fetch "$BASE/$FILE.sha256" "$TMP/$FILE.sha256" || refuse "Could not fetch $BASE/$FILE.sha256. Nothing was installed."
fetch "$BASE/$FILE" "$TMP/$FILE" || refuse "Could not fetch $BASE/$FILE. Nothing was installed."
expected="$(awk -v f="$FILE" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$TMP/$FILE.sha256")"
[ -n "$expected" ] || refuse "The checksum file has no line for $FILE. Nothing was installed."
actual="$(sha256 "$TMP/$FILE" | tr 'A-F' 'a-f')"
if [ "$expected" != "$actual" ]; then
  refuse "The checksum of $FILE does not match (expected $(printf %s "$expected" | cut -c1-12)…, got $(printf %s "$actual" | cut -c1-12)…). It was not used, and nothing was installed."
fi
say "Checksum verified."

# ---- unpack into Kestrel's folder, the user's alone -------------------------------------------------
KDIR="$HOME/.kestrel"
umask 077
mkdir -p "$KDIR/node"
chmod 700 "$KDIR"
INCOMING="$KDIR/node/.incoming.$$"
rm -rf "$INCOMING"
mkdir "$INCOMING"
tar -xzf "$TMP/$FILE" -C "$INCOMING" || refuse "Could not unpack $FILE. Nothing was installed."
got="$(cat "$INCOMING/VERSION" 2>/dev/null | tr -d '[:space:]')"
printf '%s\n' "$got" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || refuse "The bundle has no version in it. Nothing was installed."
[ -z "$VERSION" ] || [ "$got" = "$VERSION" ] || refuse "Asked for $VERSION, but the bundle is $got. Nothing was installed."
for part in bin/kestrel-node node/bin/node share/$UNIT; do
  [ -e "$INCOMING/$part" ] || refuse "The bundle is missing $part. Nothing was installed."
done

previous="$(readlink "$KDIR/node/current" 2>/dev/null || true)"
if [ -e "$KDIR/node/$got" ]; then
  # The same version again: replaced whole, so a damaged copy is mended.
  rm -rf "$KDIR/node/.replaced.$$"
  mv "$KDIR/node/$got" "$KDIR/node/.replaced.$$"
fi
mv "$INCOMING" "$KDIR/node/$got"
INCOMING="$KDIR/node/.replaced.$$"
ln -sfn "$got" "$KDIR/node/current"
# On an upgrade the version that ran before stays, for going back; older ones go. The same version again keeps all.
if [ "$previous" != "$got" ]; then
  for dir in "$KDIR"/node/*/; do
    name="$(basename "$dir")"
    [ "$name" = current ] || [ "$name" = "$got" ] || [ "$name" = "$previous" ] || rm -rf "$dir"
  done
fi
if [ -n "$previous" ] && [ "$previous" != "$got" ]; then say "Upgraded Kestrel's worker node from $previous to $got in $KDIR/node."; else say "Installed Kestrel's worker node $got in $KDIR/node."; fi

# ---- the command on PATH ------------------------------------------------------------------------
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
if [ -e "$BIN/kestrel-node" ] && [ ! -L "$BIN/kestrel-node" ]; then
  say "$BIN/kestrel-node is there and is not Kestrel's link, so it was left alone. Run $KDIR/node/current/bin/kestrel-node instead."
  NODE_CMD="$KDIR/node/current/bin/kestrel-node"
else
  ln -sfn "$KDIR/node/current/bin/kestrel-node" "$BIN/kestrel-node"
  NODE_CMD=kestrel-node
  case ":${PATH:-}:" in
    *":$BIN:"*) ;;
    *)
      say "$BIN is not on your PATH, so type $BIN/kestrel-node for now. Most systems add it at your next login;"
      say "otherwise add this line to ~/.profile:  export PATH=\"\$HOME/.local/bin:\$PATH\""
      NODE_CMD="$BIN/kestrel-node"
      ;;
  esac
fi

# ---- the service ----------------------------------------------------------------------------------
SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then SYSTEMD=1; fi
if [ "$SYSTEMD" = 1 ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cp "$KDIR/node/current/share/$UNIT" "$UNIT_DIR/$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || refuse "systemctl --user enable $UNIT failed."
  if systemctl --user is-active --quiet "$UNIT"; then
    say "Restarting the node so it runs $got (its sessions' turns are ended cleanly first)."
    systemctl --user restart "$UNIT" || refuse "systemctl --user restart $UNIT failed. See: $NODE_CMD logs"
  else
    systemctl --user start "$UNIT" || refuse "systemctl --user start $UNIT failed. See: $NODE_CMD logs"
  fi
  waited=0
  limit="${KESTREL_NODE_START_WAIT:-20}"
  until [ -S "$KDIR/node.sock" ] || [ "$waited" -ge "$limit" ]; do sleep 1; waited=$((waited + 1)); done
  if [ -S "$KDIR/node.sock" ]; then say "The node is running ($UNIT)."; else say "The service was started but the node has not answered yet. See: $NODE_CMD status, and $NODE_CMD logs"; fi
else
  say "systemd --user is not available here (no user manager for this login), so no service was set up."
  say "Start the node by hand, in tmux or screen to keep it running after you log out:  $NODE_CMD run"
fi

# ---- the two steps that need an administrator -----------------------------------------------------
if [ "$SYSTEMD" = 1 ]; then
  if [ -e "/var/lib/systemd/linger/$USER_NAME" ]; then
    :
  elif loginctl enable-linger "$USER_NAME" >/dev/null 2>&1; then
    say "Lingering is on: the node runs with nobody logged in, and starts after a reboot."
  else
    say ""
    say "Lingering is off, and turning it on needs an administrator. Ask one to run:"
    say "    sudo loginctl enable-linger $USER_NAME"
    say "Without it the node stops when your last login session ends and does not start again after a reboot."
  fi
fi

if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then install="sudo apt-get install -y bubblewrap socat"
  elif command -v dnf >/dev/null 2>&1; then install="sudo dnf install -y bubblewrap socat"
  elif command -v pacman >/dev/null 2>&1; then install="sudo pacman -S --needed bubblewrap socat"
  elif command -v zypper >/dev/null 2>&1; then install="sudo zypper install -y bubblewrap socat"
  elif command -v apk >/dev/null 2>&1; then install="sudo apk add bubblewrap socat"
  else install=""
  fi
  say ""
  say "The command sandbox needs bubblewrap and socat, which are not installed. An administrator installs them with:"
  if [ -n "$install" ]; then say "    $install"; else say "    your distribution's package manager (the packages are bubblewrap and socat)"; fi
  # The same words as kestrel-node agents (server/src/shared/node-sandbox.ts); the test holds the two together.
  say "Without them every command of a confined Claude session asks first. Restart the node after installing them:"
  say "    kestrel-node stop && kestrel-node start"
fi

# ---- what is left to do -------------------------------------------------------------------------
# A first install says both steps. An upgrade asks the node it just restarted how it is (`status --json`, the value
# `kestrel-node status` words: server/src/shared/node-status.ts) and says only what is still to do, in order: join,
# then the agents, then nothing. A node that does not answer is told both steps, as on a first install.
first_steps() {
  say ""
  say "Next: sign this node in and join your account:"
  say "    $NODE_CMD join"
  say "Then install and sign in the agents (Claude Code, Codex, OpenCode) on this node:"
  say "    $NODE_CMD agents"
}
status_json=""
if [ -n "$previous" ]; then
  status_json="$("$KDIR/node/current/bin/kestrel-node" status --json 2>/dev/null || true)"
fi
case "$status_json" in
  *'"inAccount":true'*)
    # One fact per line: JSON.stringify puts no space after a comma or colon.
    facts="$(printf '%s\n' "$status_json" | tr ',' '\n')"
    total="$(printf '%s\n' "$facts" | grep -c '"canRun":' || true)"
    can="$(printf '%s\n' "$facts" | grep -c '"canRun":true' || true)"
    say ""
    if [ "$can" -lt "$total" ]; then
      say "This node is in your account and $can of $total agents can run. Next: install and sign in the others:"
      say "    $NODE_CMD agents"
    else
      say "This node is in your account and $can of $total agents can run."
    fi
    ;;
  *) first_steps ;;
esac
say "\"$NODE_CMD status\" says how it is at any time."
