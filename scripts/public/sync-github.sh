#!/usr/bin/env bash
# The public copy of Kestrel on GitHub: this repository's tree at one commit, without the paths in
# exclude.txt, as one new commit on top of what GitHub has. GitHub never receives this repository's
# history, its commit authors or its commit bodies: only the tree, the commit's first line and its
# short id.
#
#   scripts/public/sync-github.sh --check          build the public tree and check it; push nothing
#   scripts/public/sync-github.sh                  the same, then commit it to GitHub and push
#
# The check refuses a tree with no LICENSE, with a path from exclude.txt in it, with a README that
# points at a left-out path, or with anything that looks private: a home folder path, a private
# network address, a key or token, or a line matching GITHUB_SYNC_DENY.
#
# Environment, names only (set as CI variables; nothing here is a secret's value):
#   GITHUB_SYNC_REPO          "owner/name" on GitHub. Required to push.
#   GITHUB_SYNC_KEY           a deploy key with write access: the private key, or the path of a
#                             file holding it (a File-type CI variable). Required to push.
#   GITHUB_SYNC_KNOWN_HOSTS   github.com's host keys, as known_hosts lines. When unset they are
#                             fetched with ssh-keyscan, which trusts the network at that moment.
#   GITHUB_SYNC_AUTHOR_NAME   the public commits' author (default "Kestrel").
#   GITHUB_SYNC_AUTHOR_EMAIL  and address (default "kestrel@users.noreply.github.com").
#   GITHUB_SYNC_BRANCH        the branch on GitHub (default "main").
#   GITHUB_SYNC_REMOTE       for a test: any git remote to push to instead of GitHub (no key used).
#   GITHUB_SYNC_DENY          an extended regular expression that must match nothing in the tree,
#                             for what only you know to be private (an address, a host name).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
EXCLUDE="$ROOT/scripts/public/exclude.txt"
check_only=0
case "${1:-}" in
  --check) check_only=1 ;;
  "") ;;
  *) echo "unknown option: $1 (--check, or nothing)" >&2; exit 2 ;;
esac
fail() { echo "!! public tree: $*" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tree="$work/tree"
mkdir -p "$tree"

# ---- the tree: what is committed at HEAD, minus the left-out paths ------------------------------
git -C "$ROOT" archive HEAD | tar -x -C "$tree"
excluded=()
while IFS= read -r line; do
  case "$line" in ""|\#*) continue ;; esac
  excluded+=("${line%/}")
done < "$EXCLUDE"
for path in "${excluded[@]}"; do rm -rf "${tree:?}/$path"; done

# ---- the check ----------------------------------------------------------------------------------
[ -s "$tree/LICENSE" ] || fail "there is no LICENSE"
for path in "${excluded[@]}"; do [ ! -e "$tree/$path" ] || fail "$path is still in the tree"; done
for path in "${excluded[@]}"; do
  case "$path" in .gitlab-ci.yml|.claude) continue ;; esac
  if grep -nF "]($path" "$tree/README.md" >&2; then fail "README.md links to $path, which the public copy leaves out"; fi
done

# Each pattern is something that should never be published. /Users/me and /Users/you are the
# made-up homes tests and docs use.
found=0
look() { # look <what it is> <extended regex> [grep -v filter]
  local hits
  hits="$(grep -rnIE -- "$2" "$tree" 2>/dev/null | grep -vE -- "${3:-^$}" | sed "s|^$tree/||" | cut -c1-200 || true)"
  [ -z "$hits" ] && return 0
  echo "!! $1:" >&2
  printf '%s\n' "$hits" | head -20 >&2
  found=1
}
look "a home folder path" '/(Users|home)/[A-Za-z0-9._-]+' '/(Users|home)/(me|you|[a-z]|runner|node|someone|dev|user|name|x|\$|<|\{|[A-Za-z0-9._-]*example)([^A-Za-z0-9._-]|$)|pnpm-lock\.yaml'
look "a private network address" '(^|[^0-9.])(192\.168|10\.[0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)' '10\.0\.0\.|192\.168\.[01]\.[0-9]+[^0-9]|pnpm-lock\.yaml'
look "a key or token" '(glpat-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' 'scripts/public/sync-github\.sh'
if [ -n "${GITHUB_SYNC_DENY:-}" ]; then look "a line matching GITHUB_SYNC_DENY" "$GITHUB_SYNC_DENY"; fi
[ "$found" = 0 ] || fail "it holds what should not be published (above). Fix it, or leave the path out in scripts/public/exclude.txt."

files="$(find "$tree" -type f | wc -l | tr -d ' ')"
echo "==> public tree: $files files, ${#excluded[@]} paths left out, nothing private found"
if [ "$check_only" = 1 ]; then exit 0; fi

# ---- the push -----------------------------------------------------------------------------------
branch="${GITHUB_SYNC_BRANCH:-main}"
if [ -n "${GITHUB_SYNC_REMOTE:-}" ]; then
  # A test: any git remote (a local bare repository), with no key and no GitHub.
  remote="$GITHUB_SYNC_REMOTE"
else
  [ -n "${GITHUB_SYNC_REPO:-}" ] || fail "GITHUB_SYNC_REPO is not set (owner/name)"
  [ -n "${GITHUB_SYNC_KEY:-}" ] || fail "GITHUB_SYNC_KEY is not set (a deploy key with write access)"
  key="$work/key"
  # A key pasted into a CI variable form often arrives with CRLF line ends or without its last
  # newline, and ssh then cannot read it ("error in libcrypto"): both are put right here.
  if [ -f "$GITHUB_SYNC_KEY" ]; then tr -d '\r' < "$GITHUB_SYNC_KEY" > "$key"; else printf '%s' "$GITHUB_SYNC_KEY" | tr -d '\r' > "$key"; fi
  [ -z "$(tail -c 1 "$key")" ] || printf '\n' >> "$key"
  chmod 600 "$key"
  ssh-keygen -y -f "$key" >/dev/null 2>&1 || fail "GITHUB_SYNC_KEY is not a private key ssh can read. It must be the whole key, from the BEGIN line to the END line, with no passphrase."
  hosts="$work/known_hosts"
  if [ -n "${GITHUB_SYNC_KNOWN_HOSTS:-}" ]; then printf '%s\n' "$GITHUB_SYNC_KNOWN_HOSTS" > "$hosts"; else ssh-keyscan -t ed25519,rsa github.com > "$hosts" 2>/dev/null; fi
  [ -s "$hosts" ] || fail "no host key for github.com"
  export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o UserKnownHostsFile=$hosts -o StrictHostKeyChecking=yes"
  remote="git@github.com:$GITHUB_SYNC_REPO.git"
fi

pub="$work/pub"
git init -q -b "$branch" "$pub"
git -C "$pub" remote add origin "$remote"
# An empty repository has no branch yet: the first sync makes its first commit.
if git -C "$pub" fetch -q --depth 1 origin "$branch" 2>/dev/null; then git -C "$pub" reset -q --soft FETCH_HEAD; fi
# The work tree becomes exactly the public tree: files gone from it are deleted on GitHub too.
git -C "$pub" --work-tree="$tree" add -A
if git -C "$pub" diff --cached --quiet 2>/dev/null && git -C "$pub" rev-parse -q --verify HEAD >/dev/null; then
  echo "==> GitHub already has this tree; nothing to push"
  exit 0
fi
subject="$(git -C "$ROOT" log -1 --format=%s HEAD)"
git -C "$pub" -c user.name="${GITHUB_SYNC_AUTHOR_NAME:-Kestrel}" -c user.email="${GITHUB_SYNC_AUTHOR_EMAIL:-kestrel@users.noreply.github.com}" -c commit.gpgsign=false \
  commit -q -m "$subject" -m "Source commit $(git -C "$ROOT" rev-parse --short HEAD)."
git -C "$pub" push -q origin "HEAD:$branch"
echo "==> pushed to ${GITHUB_SYNC_REMOTE:-github.com/$GITHUB_SYNC_REPO} ($branch): $subject"
