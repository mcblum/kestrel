#!/bin/sh
# Installs a Kestrel worker node for the user who runs it, on Linux (x86_64 or aarch64), with no administrator, and
# then sets it up in the same terminal. One command per channel, which one you fetch says which you get:
#
#   curl -fsSL https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/install.sh | sh        (releases)
#   curl -fsSL https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/install-beta.sh | sh   (betas)
#
# A version may still be given, 1.2.3 or 1.2.3-beta.4: through the pipe after "sh -s --" (curl -fsSL … | sh -s --
# 0.0.34), or downloaded, sh install.sh 0.0.34.
#
# Which version is the newest: publish.sh writes it into the copy it publishes (KESTREL_LATEST below), with the
# channel that copy is for, on every publish that carries the node's bundles (a beta writes install-beta.sh; a
# release writes install.sh, and install-beta.sh too when the betas move to it, as beta-mac.yml does). So a
# published copy names a version whose bundles are there. A copy that names none (this file in a checkout, or the
# copy in a bundle that `kestrel upgrade` runs) reads the newest of its channel from the published copy for that
# channel.
#
# What it does: fetches the bundle for this processor over HTTPS with its checksum, and checks the checksum before
# anything is unpacked (a mismatch stops it, leaving nothing behind); unpacks it into ~/.kestrel/node/<version>/ with
# a `current` link; makes ~/.kestrel the user's alone (mode 700: it holds the sessions' conversations); links the
# command into ~/.local/bin as `kestrel` (and `kestrel-node`, its first name), adding ~/.local/bin to PATH in the
# shell's profile when it is not there (one line, marked); writes a systemd --user unit and starts it; then runs
# `kestrel node configure` with the terminal (read from /dev/tty, since the script itself came through the pipe):
# join, the agents, git, and what only an administrator can do, each shown with the exact command. With no terminal
# it asks nothing, lists what is left and ends with "Next: kestrel node configure". Run again, it upgrades in place:
# Kestrel's data in ~/.kestrel is left as it is, and configure offers only what the node says is still to do.
#
# Environment, for trying a bundle before it is published (DEVELOPMENT.md): KESTREL_NODE_URL, a folder or address
# holding kestrel-node-linux-<arch>.tar.gz and its .sha256 (file:///… works); KESTREL_NODE_VERSION, the version;
# KESTREL_NODE_CHANNEL, stable or beta, where no version is given or written in (what `kestrel upgrade` passes);
# KESTREL_NODE_START_WAIT, how many seconds to wait for the service to answer (default 20). For the script's test:
# KESTREL_NODE_RELEASES and KESTREL_NODE_REGISTRY, where the published copies and the bundles are; KESTREL_NODE_TTY,
# the terminal to set up on (default /dev/tty).
set -eu

# Written by publish.sh into each copy it publishes: the channel the copy is for, and the newest version on it.
KESTREL_CHANNEL=stable
KESTREL_LATEST=

RELEASES="${KESTREL_NODE_RELEASES:-https://starfish.nationalmachine.io/kestrel/releases}"
REGISTRY="${KESTREL_NODE_REGISTRY:-https://starfish.nationalmachine.io/api/v4/projects/kestrel%2Freleases/packages/generic/kestrel}"
UNIT=kestrel-node.service
VERSION_SHAPE='^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'
# The line put into the shell's profile when ~/.local/bin is not on PATH; the comment at its end is how it is found again.
PATH_MARK="# added by Kestrel's worker node install"

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

VERSION="${1:-${KESTREL_NODE_VERSION:-}}"
if [ -n "$VERSION" ] && ! printf '%s\n' "$VERSION" | grep -Eq "$VERSION_SHAPE"; then
  refuse "\"$VERSION\" is not a version: give one like 0.0.34 or 0.0.34-beta.1, or none for the newest."
fi
CHANNEL="${KESTREL_NODE_CHANNEL:-$KESTREL_CHANNEL}"
case "$CHANNEL" in
  stable) CHANNEL_WORDS="release"; INSTALLER=install.sh ;;
  beta) CHANNEL_WORDS="beta"; INSTALLER=install-beta.sh ;;
  *) refuse "\"$CHANNEL\" is not a channel: stable or beta." ;;
esac

# ---- fetching -------------------------------------------------------------------------------------
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

# ---- which version --------------------------------------------------------------------------------
# Given, or written into this copy for its own channel, or read from the published copy for the channel asked for.
if [ -z "$VERSION" ] && [ -z "${KESTREL_NODE_URL:-}" ]; then
  if [ -n "$KESTREL_LATEST" ] && [ "$CHANNEL" = "$KESTREL_CHANNEL" ]; then
    VERSION="$KESTREL_LATEST"
  else
    fetch "$RELEASES/-/raw/main/$INSTALLER" "$TMP/published" || refuse "Could not fetch $RELEASES/-/raw/main/$INSTALLER to find the newest $CHANNEL_WORDS. Nothing was installed."
    VERSION="$(sed -n 's/^KESTREL_LATEST=\([0-9a-z.-]*\)$/\1/p' "$TMP/published" | head -1)"
    printf '%s\n' "$VERSION" | grep -Eq "$VERSION_SHAPE" || refuse "$INSTALLER does not name the newest $CHANNEL_WORDS. Nothing was installed."
  fi
  say "The newest $CHANNEL_WORDS is $VERSION."
fi

FILE="kestrel-node-linux-$ARCH.tar.gz"
if [ -n "${KESTREL_NODE_URL:-}" ]; then BASE="${KESTREL_NODE_URL%/}"; else BASE="$REGISTRY/$VERSION"; fi

# ---- fetch and check, before anything is written --------------------------------------------------
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
printf '%s\n' "$got" | grep -Eq "$VERSION_SHAPE" || refuse "The bundle has no version in it. Nothing was installed."
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
LAUNCHER="$KDIR/node/current/bin/kestrel-node"
mkdir -p "$BIN"
# Links `name` to the launcher unless something that is not Kestrel's link is there; then says so and fails.
link_command() { # name
  if [ -L "$BIN/$1" ]; then
    case "$(readlink "$BIN/$1")" in */.kestrel/node/*) ;; *) say "$BIN/$1 is another program's, so it was left alone."; return 1 ;; esac
  elif [ -e "$BIN/$1" ]; then
    say "$BIN/$1 is there and is not Kestrel's link, so it was left alone."
    return 1
  fi
  ln -sfn "$LAUNCHER" "$BIN/$1"
}
link_command kestrel-node || true
if link_command kestrel; then KCMD="$BIN/kestrel"; else KCMD="$LAUNCHER"; fi

case ":${PATH:-}:" in
  *":$BIN:"*) ;;
  *)
    case "$(basename "${SHELL:-sh}")" in
      bash) PROFILE="$HOME/.bashrc" ;;
      zsh) PROFILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
      *) PROFILE="$HOME/.profile" ;;
    esac
    if [ -f "$PROFILE" ] && grep -qF "$PATH_MARK" "$PROFILE"; then
      say "$BIN is put on PATH by $PROFILE already; this shell started before that. Until a new one, type $KCMD."
    else
      printf '\nexport PATH="$HOME/.local/bin:$PATH" %s\n' "$PATH_MARK" >>"$PROFILE"
      say "Added $BIN to PATH in $PROFILE (one line, marked \"$PATH_MARK\"), so a new shell finds kestrel."
      say "In this one, type $KCMD, or first:  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
    ;;
esac

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
    systemctl --user restart "$UNIT" || refuse "systemctl --user restart $UNIT failed. See: $KCMD node logs"
  else
    systemctl --user start "$UNIT" || refuse "systemctl --user start $UNIT failed. See: $KCMD node logs"
  fi
  waited=0
  limit="${KESTREL_NODE_START_WAIT:-20}"
  until [ -S "$KDIR/node.sock" ] || [ "$waited" -ge "$limit" ]; do sleep 1; waited=$((waited + 1)); done
  if [ -S "$KDIR/node.sock" ]; then say "The node is running ($UNIT)."; else say "The service was started but the node has not answered yet."; fi
  # Lingering, where this user may turn it on (some systems let them). Where not, `kestrel node configure` shows the command
  # an administrator runs.
  [ -e "/var/lib/systemd/linger/$(id -un)" ] || loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
else
  say ""
  say "systemd --user is not available here (no user manager for this login), so no service was set up."
  say "Start the node by hand, in tmux or screen to keep it running after you log out:"
  say "    $KCMD node run"
  say "then set it up, in another terminal:"
  say "    $KCMD node configure"
  exit 0
fi

# ---- set it up ------------------------------------------------------------------------------------
# The script came through a pipe, so the keyboard is the terminal itself. Where there is none, configure asks nothing:
# it lists what is left, each with its command, and ends with "Next: kestrel node configure". It is the same
# `kestrel node configure` either way, which asks the node what is left (never a flag kept here), so an upgrade offers
# only what is still to do.
TTY="${KESTREL_NODE_TTY:-/dev/tty}"
say ""
if (: <"$TTY") 2>/dev/null; then
  say "Setting the node up now. Any step can be skipped; \"kestrel node configure\" picks up where you left off."
  "$KCMD" node configure <"$TTY" || true
else
  "$KCMD" node configure </dev/null || true
fi
