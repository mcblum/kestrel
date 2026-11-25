# Releasing Kestrel

Kestrel is released for the Mac. Builds for Windows and Linux can be made (0.0.23) but are not
released yet: neither has been installed and tried, so 0.0.23 ships as the Mac app alone (Matt,
2026-11-21). The table says what each build is; installed copies poll one feed per platform
(electron-updater, generic provider).

| Platform | What is built | Feed | Signed | Built by |
|---|---|---|---|---|
| macOS, Apple Silicon | `Kestrel.dmg`, an update zip | `latest-mac.yml` | Developer ID, notarized | `make-release.sh`, by hand on a Mac |
| Windows, x64 | `Kestrel-Setup-<v>-x64.exe` (NSIS, per user, no administrator prompt) | `latest.yml` | **not signed**: SmartScreen asks on first run | `make-release-desktop.sh --platform windows` (the `package-windows` CI job) |
| Linux, the builder's architecture | `Kestrel-<v>-x86_64.AppImage` | `latest-linux.yml` | an AppImage carries none | `make-release-desktop.sh --platform linux` (the `package-linux` CI job) |

A release is cut by CI when a merge raises the version (below); every step can still be run by
hand. What each platform has and lacks once installed is in the design doc ("Windows and Linux").

## What a merge does

Every merge request runs the pipeline in [.gitlab-ci.yml](.gitlab-ci.yml):

| Job | What it checks |
|---|---|
| `typecheck` | `pnpm typecheck` across the workspace |
| `test` | `pnpm test` (the server's unit and integration tests) |
| `build-ui` | the production build of the UI |

On a merge request `package-linux` and `package-windows` are there to start by hand (the play
button), to try a build before merging. Nothing is published from a merge request.

## A release: raise the version and merge

A merge to `main` that changed `app/package.json` and left its version newer than the one the live
feed serves is a release. `scripts/release/release-needed.sh` is the one check, asked by every job
below; a merge that touched the file without raising the version builds and publishes nothing (each
job says "Nothing to release" and passes).

| Job | Runner | Starts | What it does |
|---|---|---|---|
| `release-notify` | k3s (Linux) | by itself, after the checks | posts to Slack that a release is waiting, tagging Matt, with a link straight to the `release` job |
| `release` | the Mac runner (`macos`) | **by hand** | builds, signs and notarizes the Mac app and publishes it (`scripts/release/ci-release.sh`) |

So: write or finish `whats-new/<version>.md` (below, "Release notes"), bump `version` in `app/package.json` in a merge request, merge it, wait for the Slack message
(`scripts/release/notify-slack.sh`; the same shape as configuration-management's Cloudflare review
message), follow its "Start the release" link and press play. A Slack outage, or no webhook set,
never holds a release up: the job says where the button is and passes. One release runs at a time
(`resource_group: release`) and is never cancelled part-way. Its `dist/release` is kept as an
artifact only when it fails, so a notarized build that failed to publish can be published by
hand with `publish.sh` instead of rebuilt. A published release keeps none: its build is in the
package registry, and is larger than the server accepts as an artifact (the upload was refused
with 413 and turned published releases red, 0.0.23 to 0.0.27). The same limit means the upload
after a failure is refused too until the instance's maximum artifact size is raised.

`package-linux` and `package-windows` are in the pipeline to start by hand, on a merge request or on
`main`, and nothing waits on them. Once both builds have been made and tried on real computers,
making them part of a release is: have them start by themselves on a version bump, have `release`
take their artifacts (`needs` with `artifacts: true`), and have `ci-release.sh` require them.

`release` is started by hand on purpose, so a person looks before users get an update. To have a
version bump release with no click, remove `when: manual` and `allow_failure` from the job.

What it needs, once:

- The CI variable `KESTREL_GITLAB_TOKEN` on this project (protected, masked): api scope, may commit
  to `main` of `kestrel/releases`. The job refuses to start without it, saying so.
- The CI variables `KESTREL_SLACK_WEBHOOK_URL` (a Slack incoming webhook; masked) and
  `KESTREL_SLACK_MENTION` (who to tag, as Slack writes it: `<@MEMBERID>`). They are variables, not
  in the script, because `scripts/` is published.
- On the Mac runner (looked at 2026-11-21, changing nothing): Node 24.18 and corepack are there
  and the job turns pnpm on with `corepack enable`; Xcode 26.6 with swiftc, notarytool and stapler;
  the Developer ID identity; jq, python3; npm, GitHub and the releases feed are reachable. Two
  thing to mind: the `Vireo` notarytool profile could not be read over SSH,
  which is expected (the login keychain is unlocked only in the runner's own session, where Vireo's
  and Shrike's releases use it) but was therefore not confirmed for Kestrel.

The Mac runner's disk is 130 GB and shared by every app. It had 11 GB free; on 2026-11-21 the
watchOS, tvOS and visionOS simulator runtimes (which no app's CI uses; `xcodebuild -downloadPlatform`
brings one back), the Sparkle appcast cache and Homebrew's download cache were removed, leaving
39 GB free. A Kestrel release needs roughly 5 to 6 GB while it runs, and `release` cleans up after
itself whether it passed or failed (`scripts/release/ci-cleanup.sh`): dependencies, the staged app,
electron-builder's output and the fetched binaries go; only `dist/release` stays, for the artifact
upload after a failure, until the next job's checkout removes it. pnpm's and Electron's download caches are kept,
since they are what makes the next release quick.

**None of this has run yet** (written 2026-11-21). The first release through it should be watched:
the likeliest fix is something the Mac runner lacks for an Electron build that it has for the
Swift apps.

The three jobs run only when Kestrel's code changed: `server/`, `ui/`, `app/`, `scripts/release/`, the lockfile and
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

## Release notes

One source: `whats-new/<release>.md` in this repository (`whats-new/0.0.32.md`). The same file is the
app's What's new page, which opens by itself the first time an updated copy starts, and the release's
notes on the host. It is public, like the rest of the tree.

- **Shape** (Matt, 2026-11-25: "A headline for the feature, a brief description, and then a link to
  where to enable / configure / use it"). The first line is the title, `# Kestrel 0.0.32`. Then, for the
  page's spotlight layout:

  ```
  ## Kestrel Connect                      the headline feature's name (optional)
  ### See your sessions from any computer.
  One or two sentences.
  [Open Connections](#/settings/connections)
  ![End-to-end encrypted](images/connect-devices.svg)   optional; the alt text is its caption
  ## Also in this release
  ### MCP servers                         one ### per entry: headline, a sentence or two, a link
  ## More changes                         optional; folded on the page
  ```

  Every entry (and the spotlight) is at most `NOTES_ENTRY_MAX`, 200 characters, not counting its link or
  picture, with at most one link into the app, on a line of its own. No lists, no headings inside an
  entry, no commit lists, no names of private systems. A file with none of these headings is drawn as
  plain Markdown, each `##` section then read as one entry; one that has some of them but not the whole
  sequence fails the test, which says what is missing. A test over every notes file
  (`server/src/whats-new/whats-new.test.ts`, `notesFormatProblems` in `shared/whats-new-layout.ts`) fails
  and names the entry that breaks this. A picture is `![what it shows](images/<name>.png)` from
  `whats-new/images/`; the host's notes leave every picture out, captions included, and keep the headings.
- **The spotlight's illustration and caption.** They come from the release, not the app:
  1. Draw the illustration as an SVG and save it as `whats-new/images/<name>.svg` (0.0.32's is
     `connect-devices.svg`). Draw in `stroke="currentColor"` or `fill="currentColor"`, not fixed colours:
     the page draws it in the spotlight's blue and follows light and dark. Give the `<svg>` a `viewBox`
     and the `width` and `height` it should be drawn at (around 180 × 50). A shape that should hide what
     is behind it (a backing circle under a lock) gets `class="surface"` and takes the card's colour.
  2. Use plain shapes only: `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`, `g`
     (with `transform`), `title`. Anything else (text, gradients, `use`, embedded images, styles, links,
     scripts) is left out when it is drawn; a file that is not one plain `<svg>` is not shown at all. A
     test checks every SVG in `whats-new/images/` reads as a plain drawing.
  3. In the spotlight section, after its link, put the picture line with the caption as its alt text:
     `![End-to-end encrypted](images/<name>.svg)`. A photo or screenshot works the same way with a
     `.png` or `.jpg`. Without a picture line the text takes the whole card.
  4. Look at it: `#/whats-new/<release>` in a checkout, light and dark. The drawing shows beside the text
     when the pane is wide and is hidden when it is narrow.
- **Links into the app.** A section can end with a link to where the feature lives:
  `[Open Settings → Git](#/settings/git)`, `[Open Code reviews](#/code-reviews)`. On the What's new page
  a click, and the spotlight's button, opens it in a new tab beside the notes (or the tab already
  showing it), so the notes stay open. The host's notes drop a line or sentence that is only such a link and keep a link inside
  a sentence as its words. A test fails when a notes file links to a page the app does not have.
- **Through a cycle.** Start the file with the first beta and add to it as features land. A beta
  (`0.0.32-beta.3`) shows its release's file; each time the file changes, copies on the beta channel
  show it again after they update. A beta with no file publishes as before and shows nothing.
- **A release must have it.** `preflight.sh` (the first step of `make-release.sh`, so of the `release`
  job) refuses a release whose file is missing or has no title line, before anything is built:

  ```
  !! preflight: Kestrel 0.0.33 has no release notes: write whats-new/0.0.33.md (…) and commit it before releasing
  ```

  `publish.sh` asks again, then makes the GitLab Release's description from the file: the text under
  the title, pictures left out, then the download lines. `scripts/release/release-notes.mjs check|body
  <version>` is the one reader; it uses the app's own rules (`server/src/shared/whats-new.ts`).
- **Trying it.** The page is `#/whats-new` in a checkout too. A checkout never opens it by itself;
  `KESTREL_WHATS_NEW_AS_INSTALLED=1` on the server makes it behave as an installed copy would. The real
  path is an installed beta updating to the next beta whose notes changed (design doc, "What's new").

## Version

One source: `version` in `app/package.json`. It goes into the bundle (`CFBundleShortVersionString`),
the About panel, Settings > General, and the updater's comparison with the feed. Bump it in the
merge request that should become a release.

It is `1.2.3` for a release or `1.2.3-beta.4` for a beta; anything else (`1.2.3-rc.1`, `1.2`) is
refused by every script. The channel follows from the version alone, by one function
(`app/release-channel.mjs`; the shell scripts ask it through `scripts/release/version.mjs`).

## Beta versions

A beta is a build of the next version for the people who turned on **Get beta versions**
(Settings → General → Updates) and nobody else. It goes through the same scripts and the same CI
job as a release; only the version string differs.

| | A release (`0.0.32`) | A beta (`0.0.32-beta.1`) |
|---|---|---|
| Is due when newer than | `latest-mac.yml` | both `latest-mac.yml` and `beta-mac.yml` (a beta never follows its release) |
| Uploaded to the package registry | zip, blockmap, DMG | the same, as package version `0.0.32-beta.1` |
| GitLab Release, permanent `Kestrel.dmg` link, release notes | made, and moved to it; the notes are `whats-new/<v>.md`, required | **none**: they stay on the last release; `whats-new/<release>.md` is shown in the app if it is there |
| Feeds committed | `latest-mac.yml`, and the same text as `beta-mac.yml` unless that already serves a newer beta | `beta-mac.yml` only |
| Who gets it | every copy | copies with Get beta versions on |
| Printed at the end | the feeds and the permanent download | the beta feed and the beta DMG's own address in the registry |

An installed copy with Get beta versions off reads `latest-mac.yml`. With it on, it reads
`beta-mac.yml`, unless that is missing or older than `latest-mac.yml` (then the stable feed); it
reads both versions before each check to decide (`app/updater.mjs`). So a beta copy takes each new
beta, and moves to `0.0.32` when `0.0.32` ships (a beta comes before its release). No copy is ever
downgraded: electron-updater turns `allowDowngrade` on whenever its `channel` is set, and the updater
turns it off again every time. Turning betas off keeps the beta that is installed until a release
newer than it ships; a beta already downloaded when the switch is turned off is still installed
when Kestrel quits.

The choice is kept by the app shell, not the server, because the updater runs in the shell and
needs it before the server starts: `update-channel.json` in the shell's userData folder
(`~/Library/Application Support/Kestrel/`, or `KESTREL_APP_USER_DATA`), `{"beta": true}` or
`{"beta": false}`. Without the file a beta build is on the beta channel and a release is not, which
is how the first beta, installed by hand on a computer whose copy had no switch, comes up on the
beta channel. About and Settings → General show the version with `(beta)` and which channel the copy
is on.

### Cutting a beta

1. In the merge request, set `version` in `app/package.json` to the next version with a beta
   number: `0.0.32-beta.1` (then `0.0.32-beta.2`, …; the release itself is `0.0.32`).
2. Merge. `release-notify` posts "Kestrel 0.0.32-beta.1 (beta channel only) is ready to release".
3. Press play on `release`. It builds, signs, notarizes, uploads, commits `beta-mac.yml`, checks the
   public beta feed, and ends with:

   ```
   Published Kestrel 0.0.32-beta.1 to the beta channel only
       feed:     https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/beta-mac.yml
       download: https://starfish.nationalmachine.io/api/v4/projects/<id>/packages/generic/kestrel/0.0.32-beta.1/Kestrel-0.0.32-beta.1-arm64.dmg
   ```

4. **The first beta on a computer** is installed by hand: download that DMG, quit Kestrel, drag
   Kestrel to Applications replacing the old one, open it. Its switch starts on; Settings → General
   says "0.0.32-beta.1 (beta)" and "On the beta channel". From then on it updates itself. On a
   computer already running a beta, nothing is needed.
5. To go back to stable: turn off Get beta versions. The copy stays on its beta until a release
   newer than it ships (`0.0.32` is newer than every `0.0.32-beta.n`), then takes that.

By hand the same is `scripts/release/make-release.sh --feeds https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/`
then `scripts/release/publish.sh`, with `version` set as in step 1.

What a beta does not do: it makes no GitLab Release, so the permanent download link
(`…/permalink/latest/downloads/Kestrel.dmg`) and the release notes still give the last release; it
does not touch `latest-mac.yml`, so copies on the stable channel never see it; it is announced
nowhere except Matt's own Slack message from `release-notify`. The beta's DMG is public in the
package registry (the project is public), but nothing links to it.

What has been checked (2026-11-24): the updater's choice against a local feed, in Electron 45.3.2
with electron-updater 6.8.11, for every case above (scripts aside: a scratch Electron app with
the version under test and the real `release-channel.mjs`, as `app/updater.mjs` uses it); a
`--skip-notarize` build of `0.0.32-beta.1` (it wrote `beta-mac.yml` and no `latest-mac.yml` or
`Kestrel.dmg`), and that build, opened with empty userData against a local feed: it came up on the
beta channel, read both feeds, chose `beta-mac.yml`, and refused to downgrade. Not
checked until the first real beta: notarizing a prerelease version string, the registry accepting
the version `0.0.32-beta.1`, Squirrel installing a prerelease over a release on a real Mac, and the
public `beta-mac.yml`.

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
   `.blockmap`, `latest-mac.yml` and the same text as `beta-mac.yml` (relative URLs, for a local
   test server). A beta writes no `Kestrel.dmg` and no `latest-mac.yml`: only `beta-mac.yml`.

Options: `--skip-notarize` (sign only, for quick local builds that will not open on another
Mac), `--allow-dirty`, `--feeds <base URL or folder>` (refuse a version that is not due against the
feeds there, by `release-needed.sh`), `--version x.y.z` or `x.y.z-beta.n` (put another version in
the bundle without touching `app/package.json`, for updater tests).

Environment, names only: `KESTREL_SIGN_ID` (default `Developer ID Application: Matthew Blum
(NLJAPE8842)`), `KESTREL_NOTARY_PROFILE` (default `Vireo`, a notarytool keychain profile).

The icon comes from `Brand/masters/bird.svg`; `scripts/release/make-icon.sh` regenerates
`Brand/exports/` (commit both).

## Building for Windows and Linux

```bash
scripts/release/make-release-desktop.sh --platform linux
```

```bash
scripts/release/make-release-desktop.sh --platform windows
```

The two CI jobs run these when started by hand. To publish one with a Mac release, copy its files
into `dist/release` beside the Mac build of the same version and run `publish.sh` by hand. What the script does: install, build the
UI, stage for the target (`stage.mjs --platform … --arch …`), package with electron-builder, write
the platform's feed.

- **Linux** must be built on Linux: node-pty has no Linux prebuild and is compiled when it is
  installed (python3, make, g++), so the AppImage is for the architecture it was built on.
- **Windows** can be built on Windows, or on Linux or a Mac with `wine` on PATH (electron-builder
  uses it to write the icon and version into `Kestrel.exe`). node-pty ships a Windows prebuild, and
  the Windows Claude Code binary is fetched from npm at the Agent SDK's exact version
  (`fetch-claude-binary.mjs`, into `dist/cache`). `--no-exe-edit` builds without wine and leaves
  Electron's icon on the program: a packaging check, never a release.
- Neither is code-signed. `--allow-dirty` and `--version` work as for the Mac build.

What has been checked, and what has not (2026-11-21, all work done on a Mac):

- Checked: the Windows installer builds on a Mac with `--no-exe-edit` (234 MB; node-pty's prebuild
  and `claude.exe` are in `resources`). `pnpm typecheck`, `pnpm test` and the UI build pass.
- **Not checked: nobody has installed or run either build.** The Linux build has never been made
  (it needs Linux). The two CI jobs have never run; `package-windows` installs wine with apt, which
  is the likeliest thing to need a fix. Updating itself on Windows and Linux has not been tried.
- Not checked on a real computer: Codex and OpenCode on Windows (found as `.exe` or npm's `.cmd`),
  a signed commit inside the Linux sandbox, anything in Kestrel that compares paths written with
  backslashes.

## Publishing

```bash
scripts/release/publish.sh --dry-run       # checks, lookups, and every request it would send
scripts/release/publish.sh
```

With a Windows installer or a Linux AppImage of the same version in `dist/release`, it publishes
those too: uploaded with the Mac files, linked from the Release (`/Kestrel-Setup.exe`,
`/Kestrel.AppImage`), and their feeds committed beside `latest-mac.yml`. Each must have its feed
beside it and say the same version. The Mac build is always required.

For the Mac build it refuses artifacts that are not notarized and stapled, anything that carries a local home
path, the git email or a token, and a version not newer than the live feed's (`--force` to
replace). Then: uploads the zip, its blockmap and the DMG to the generic package registry of
`kestrel/releases` (package `kestrel`, version `<v>`, replacing that version's files), creates
Release `v<v>` with asset links (the DMG's filepath is `/Kestrel.dmg`), commits
`latest-mac.yml` with absolute registry URLs to `main`, and checks the public feed and every
URL in it without a token.

- Download: `https://starfish.nationalmachine.io/kestrel/releases/-/releases/permalink/latest/downloads/Kestrel.dmg`
- Windows and Linux: the same address ending in `Kestrel-Setup.exe` and `Kestrel.AppImage`
- Feed: `https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/latest-mac.yml`, and
  `latest.yml` and `latest-linux.yml` beside it; the beta channel's `beta-mac.yml`, `beta.yml` and
  `beta-linux.yml` there too
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
`--user-data-dir` (its `update-channel.json` is the beta switch). `KESTREL_UPDATE_FIRST_CHECK_MS` shortens the first check's delay;
`KESTREL_UPDATE_NO_RELAUNCH=1` makes Restart install without reopening (Squirrel reopens the
app with no arguments, which would land a test copy on the real profile).

## Not automated yet

- Code signing for Windows; a `.deb` for Linux.
- Opening the version-bump merge request (Shrike's `release:cut`), and a release with no new commit.
- A CI image with wine already in it, so `package-windows` does not install it on every run.
- Tagging the source repo, and the edge outage-cache group for the releases project.
