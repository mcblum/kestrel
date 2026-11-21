# Releasing Kestrel

Kestrel ships as a signed, notarized app for Macs with Apple Silicon: `Kestrel.dmg` to install,
and an update zip plus `latest-mac.yml` that installed copies poll (electron-updater, generic
provider). Releases are built by hand on a Mac today; there is no release job in CI yet.

## What a merge does

Every merge request runs the pipeline in [.gitlab-ci.yml](.gitlab-ci.yml):

| Job | What it checks |
|---|---|
| `typecheck` | `pnpm typecheck` across the workspace |
| `test` | `pnpm test` (the server's unit and integration tests) |
| `build-ui` | the production build of the UI |

The three jobs run only when Kestrel's code changed: `server/`, `ui/`, `app/`, the lockfile and
workspace files, or the CI file itself. A change to docs, the design prototype or the spike
scripts runs a single `no-code-changes` job instead, so the merge request still has a passing
pipeline. The same rule applies again on `main` after the merge. Nothing is built for release,
tagged or deployed by a merge.

Two more jobs concern the public copy on GitHub (Kestrel is open source, AGPL 3.0):

| Job | What it does |
|---|---|
| `check-public-tree` | on every merge request and on `main`: builds the tree GitHub would get and fails if it has no LICENSE or holds anything private (a home path, a private address, a key, a line matching `GITHUB_SYNC_DENY`) |
| `sync-github` | on `main` only, last: commits that tree to GitHub as one new commit |

GitHub gets the tree without the paths in `scripts/public/exclude.txt` (the design doc,
`CLAUDE.md`, the spike, the prototype, this CI file), the commit's first line and its short id.
It never gets this repository's history, authors or commit bodies, so write the first line of a
commit as something the public may read. `sync-github` is off until the CI variables
`GITHUB_SYNC_REPO` (owner/name) and `GITHUB_SYNC_KEY` (a deploy key with write access) exist;
`scripts/public/sync-github.sh` lists the rest. Run `scripts/public/sync-github.sh --check`
locally to see what a merge would publish.

Merge requests are fast-forward only and need a passing pipeline. Nobody pushes to `main`
directly.

## Version

One source: `version` in `app/package.json`. It goes into the bundle (`CFBundleShortVersionString`),
the About panel, Settings > General, and the updater's comparison with the feed. Bump it in the
merge request that should become a release.

## Building a release

```bash
scripts/release/make-release.sh            # from a clean tree, on an Apple Silicon Mac
```

1. `preflight.sh`: clean tree (tracked files), the Developer ID identity in the keychain, the
   notarytool profile works, and with `--feed <url|file>` that the version is newer than the feed's.
2. `pnpm install`, the simulator helper (`build:simhelper`), the UI (`vite build`).
3. `app/scripts/package/stage.mjs` lays out the app in `dist/stage`: the shell bundled with
   electron-updater (esbuild), the built UI, the server bundled to one JavaScript file, node-pty,
   the Claude Code binary the Agent SDK runs, and `kestrel-sim`.
4. electron-builder (`app/electron-builder.config.cjs`) packages and signs it with the hardened
   runtime; its afterSign hook notarizes and staples the app (`notarize.sh`), so the DMG and the
   zip are made from the stapled app.
5. The DMG is signed, notarized and stapled.
6. `dist/release/`: `Kestrel.dmg`, `Kestrel-<v>-arm64.dmg`, `Kestrel-<v>-arm64-mac.zip` and its
   `.blockmap`, `latest-mac.yml` (relative URLs, for a local test server).

Options: `--skip-notarize` (sign only, for quick local builds that will not open on another
Mac), `--allow-dirty`, `--feed`, `--version x.y.z` (put another version in the bundle without
touching `app/package.json`, for updater tests).

Environment, names only: `KESTREL_SIGN_ID` (default `Developer ID Application: Matthew Blum
(NLJAPE8842)`), `KESTREL_NOTARY_PROFILE` (default `Vireo`, a notarytool keychain profile).

The icon comes from `Brand/masters/bird.svg`; `scripts/release/make-icon.sh` regenerates
`Brand/exports/` (commit both).

## Publishing

```bash
scripts/release/publish.sh --dry-run       # checks, lookups, and every request it would send
scripts/release/publish.sh
```

It refuses artifacts that are not notarized and stapled, anything that carries a local home
path, the git email or a token, and a version not newer than the live feed's (`--force` to
replace). Then: uploads the zip, its blockmap and the DMG to the generic package registry of
`kestrel/releases` (package `kestrel`, version `<v>`, replacing that version's files), creates
Release `v<v>` with asset links (the DMG's filepath is `/Kestrel.dmg`), commits
`latest-mac.yml` with absolute registry URLs to `main`, and checks the public feed and every
URL in it without a token.

- Download: `https://starfish.nationalmachine.io/kestrel/releases/-/releases/permalink/latest/downloads/Kestrel.dmg`
- Feed: `https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/latest-mac.yml`
  (the app's `FEED_URL` in `app/updater.mjs`; `KESTREL_UPDATE_FEED` overrides it for tests)

What `publish.sh` assumes about `kestrel/releases`: public; default branch `main` (or an empty
project: the script makes the first commit); the token (api scope, `KESTREL_GITLAB_TOKEN` or the
keychain item `-a vireo -s gitlab-token`) may commit to `main` through the files API, so `main`
must not be protected against that user; packages and releases enabled. `GITLAB_UPLOAD_HOST`
sends the big uploads straight to the GitLab box when the edge's upload size limit is in the way.

## Testing an update locally

Build two signed versions (`--skip-notarize --version 0.0.2` for the newer one), serve the
newer `dist/release` with any static server, and open the older copy with
`KESTREL_UPDATE_FEED=http://127.0.0.1:<port>/`, its own `KESTREL_DATA_DIR` and
`--user-data-dir`. `KESTREL_UPDATE_FIRST_CHECK_MS` shortens the first check's delay;
`KESTREL_UPDATE_NO_RELAUNCH=1` makes Restart install without reopening (Squirrel reopens the
app with no arguments, which would land a test copy on the real profile).

## Not automated yet

- A release job on the Mac runner (cut on a version bump merged to `main`, like Shrike/Vireo).
  Kestrel's CI is untagged and never runs on the Mac today.
- Tagging the source repo, release notes, and the edge outage-cache group for the releases project.
