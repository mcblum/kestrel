# Developing Kestrel

Build, run, and test Kestrel locally. For the Mac app download and a product overview, see the [README](README.md).

## Run it from source

Needs Node 24 or newer (the server uses Node's built-in SQLite) and pnpm.

```bash
pnpm install
```

Start the server first, then the UI, each in its own terminal:

```bash
pnpm dev:server
```

```bash
pnpm dev:ui
```

Open http://localhost:5173. The server listens on `127.0.0.1:4317` only.

### The native app

```bash
pnpm dev:app
```

Opens Kestrel in an Electron window. It starts its own server (on a free port, as a child process
on Electron's Node), so it does not collide with `pnpm dev:server` / `pnpm dev:ui`. Both use
`~/.kestrel-dev` unless you set `KESTREL_DATA_DIR`, so give one of them its own if you run both
at once. (`~/.kestrel` is kept for an installed app; nothing run from this checkout opens it.) Quitting the app stops the server and any agents; with agents at work it asks first (`app/quit-guard.mjs`), except when stopped from its terminal (Ctrl-C, `pnpm dev:restart`), which goes ahead and says so. To run the built UI instead of Vite:
`pnpm --filter @kestrel/ui build`, then `pnpm --filter @kestrel/app start`.

A signed, notarized `Kestrel.dmg` (Apple Silicon) is built by `scripts/release/make-release.sh`,
and the Windows installer and Linux AppImage by `scripts/release/make-release-desktop.sh`;
the installed app uses `~/.kestrel` and updates itself. See [RELEASING.md](RELEASING.md).

Kestrel runs from source on macOS, Linux and Windows. What differs between them is asked in one
place, `server/src/host.ts` (which shell, how a command is ended) with the names and words in
`server/src/shared/platform.ts`; a feature that cannot work on a platform refuses with the reason.
On Linux, install `bubblewrap` and `socat` for the sandbox that holds a child session's commands.

Tabs: ⌘N or ⌘T new session tab, ⌘W close tab, ⌘1–9 switch, ⌘K switch session. Right-click the
sidebar to add a project, folder or session. (Browsers reserve some of these shortcuts; the
buttons and the menu always work.)

The server makes a new access token every time it starts and writes it to
`~/.kestrel-dev/launch.json` (readable by you only). The Vite dev server hands that token
to the page; in the app the Electron shell makes the token and hands it over itself. If the
server restarts, an open page fetches the new token by itself.

### A worker node (no window)

```bash
pnpm --filter @kestrel/server kestrel node run        # starts the node: the same server, no window, no UI origin
pnpm --filter @kestrel/server kestrel                 # one line of how the node is, and the commands
pnpm --filter @kestrel/server kestrel node            # the node's commands
pnpm --filter @kestrel/server kestrel node status     # asks the running node, over its socket
pnpm --filter @kestrel/server kestrel node stop       # ends its sessions' turns and stops it
pnpm --filter @kestrel/server kestrel node join       # signs in with a code typed on another device, then asks to join
pnpm --filter @kestrel/server kestrel node configure  # join, agents, git and the administrator's steps, one after another
pnpm --filter @kestrel/server kestrel version         # the version
```

(`kestrel` here is the package script; installed, the command is `kestrel` too. `kestrel` is a general command, and the
worker node's commands are its `node` group. The first version's words with no group, `kestrel-node run`, `kestrel status`,
`kestrel setup` and the rest, are still taken: an installed node's unit and install script type them. The `kestrel-node`
package script is kept for the same reason.) `server/src/node.ts` calls the same start function as `server/src/index.ts` (`startKestrel` in
`server/src/start-server.ts`) with kind `node`. It listens on loopback only (the token and the Host and Origin checks stand,
and no browser origin is allowed), keeps Kestrel Connect's sign-in in the file only you can read, and talks to the terminal over
`node.sock` in its data folder (mode 600; `KESTREL_DATA_DIR` for another folder, kept short: a Unix socket's path is limited
to about a hundred bytes). What needs a screen refuses with the reason (`server/src/shared/no-window.ts`).

`join` signs in to Kestrel Connect by a device authorization grant as the realm's `kestrel-node` client (it prints an address
and a short code to open on any device), then asks to join the account: a device already in it opens the request and types
the six-digit code the node prints, and the node asks for the second code that device shows. Ctrl-C withdraws. The tests drive it
with fakes and reach no network (`server/src/node-control/node-join.test.ts`).

```bash
pnpm --filter @kestrel/server kestrel node start              # starts the installed service, or says how to run it
pnpm --filter @kestrel/server kestrel node logs [-f] [-n 500] # the node's log: journalctl for its unit, else its log file
pnpm --filter @kestrel/server kestrel node uninstall          # leaves the account and removes the installed node
```

`status`, `stop`, `join` and the node's part of `uninstall` go over the socket, from one closed list (`NODE_COMMANDS` in
`server/src/shared/node-commands.ts`); `start` and `logs` are the terminal's alone (`TERMINAL_COMMANDS`), since the node
may not be running to answer. `status` still says what it can when nothing answers: lingering, the service, free disk
and the installed bundle. A node not started by systemd writes its log to `logs/node.log` in its data folder (mode 600,
one rotation).

#### A bundle and the install script

The bundle is built on Linux (node-pty is compiled for it). From a Mac, in Docker, with the checkout mounted:

```bash
docker run --rm -v "$PWD":/src -w /src node:24-bookworm sh -c \
  'corepack enable && pnpm install --frozen-lockfile && scripts/release/node-bundle/build.sh x64'
```

On an Apple Silicon Mac that container is arm64 unless `--platform linux/amd64` is given (emulated, slow); for
`arm64` the build is native there and runs its own check. Either leaves `dist/node/kestrel-node-linux-<arch>.tar.gz`
and its `.sha256` (RELEASING.md, "The worker node's bundles"). `pnpm install` inside the container replaces the
checkout's `node_modules` with Linux ones: run `pnpm install` again on the Mac afterwards, or build from a second
clone.

To try the install script without publishing, point it at that folder; it reads
`<url>/kestrel-node-linux-<arch>.tar.gz` and its `.sha256` from there, whichever version is asked for:

```bash
KESTREL_NODE_URL=file:///src/dist/node sh scripts/release/install.sh
```

On a test machine or container, copy the bundle, its `.sha256` and the script over and run it there as the node's
user, the same way (`KESTREL_NODE_URL=file://$HOME/bundle sh install.sh`). As through `curl | sh`, it goes on
to `kestrel node configure` on the terminal; `KESTREL_NODE_TTY=/nowhere` shows what it does with no terminal. On a machine or
container with a systemd user manager (a plain `docker run` has none: the script then says so and how to run
`kestrel node run` by hand, then `kestrel node configure`). Run it twice to see an upgrade in place. `KESTREL_NODE_START_WAIT`
(seconds, default 20) is how long it waits for the node's socket. Its tests run it against stub `uname`, `id`,
`systemctl`, `loginctl` and a package manager in a temporary home, fetching over `file://`, with no network:

```bash
node --test scripts/release/install.test.mjs
```

### Sessions from another computer, without a second computer

```bash
KESTREL_DATA_DIR=~/.kestrel-remote-sessions-preview pnpm --filter @kestrel/server exec tsx scripts/seed-remote-sessions.ts
```

Puts four sessions of a pretend "Studio Laptop" into that store's replica (`server/scripts/seed-remote-sessions.ts`):
a short one, a long one of 320 messages with attachments and a tool's picture, one running, and one whose copy is
behind its head (the page asks the laptop, which is never there, and says it did not answer). It needs
`KESTREL_DATA_DIR` and refuses the installed app's store; run it with the server stopped, then start the server and
UI on that store (the `kestrel-remote-sessions` entry of `.claude/launch.json` does both, on ports 4387 and 5243).
Nothing in the app runs it.

### The demo workspace

```bash
pnpm demo            # --fresh makes it again from nothing; --light or --dark forces the theme
```

Opens the Electron app on a workspace made for screenshots: four sample projects with real
folders, sessions in every state on all three agents, groups (one inside a project), tags, pins,
an archived session, two workstreams (one complete, one with a session waiting on another), a
handoff, pull requests in several states, code reviews with a finished review, and saved actions.
A scripted agent stands behind "Claude", so a new session answers (`server/src/agents/scripted.ts`
lists what a message does: `/review`, `/approve`, `/stream 20`, …). No model is called and nothing
is posted anywhere. Its data is in `~/.kestrel-demo` and it keeps its own app state, so it runs
beside your real Kestrel. `KESTREL_DEMO=1` is the switch (`server/src/seed-demo.ts`); the browser
and simulator panes and the terminal are live parts, so they are empty until you use them.

`pnpm demo --story` opens one chosen moment instead, for a screenshot that has to be read at a
glance: one task split across App, API and Docs as one workstream, one of the three sessions
waiting on a question (the window opens on it), and the unrelated folders folded. It keeps its own
data in `~/.kestrel-demo-story`; `KESTREL_DEMO_SCENE=story` is the switch
(`server/src/seed-story.ts`). `pnpm demo --story --reviews` is the same moment with two review
requests waiting in CODE REVIEWS (`KESTREL_DEMO_SCENE=story-reviews`, data in
`~/.kestrel-demo-story-reviews`).

`pnpm demo --tickets` is the demo with tickets switched on and a sample tracker holding one sprint
of tickets, one of them under way: open Tickets in the top menu, and try Work this ticket, moving a
status and the cards that propose a change (`KESTREL_DEMO_SCENE=tickets`, data in
`~/.kestrel-demo-tickets`). The sample tracker forgets its moves and comments when the server
restarts. `pnpm demo --sidebar` seeds a busy organization's workspace, for looking at the sidebar
with many projects, colours and pins.

To start again from clean fake data, run with `KESTREL_FAKE=1` and delete
`~/.kestrel-dev/kestrel-fake.sqlite*`. Worktrees live in `~/.kestrel-dev/worktrees/`.

| Variable | Default | Meaning |
|---|---|---|
| `KESTREL_PORT` | `4317` | Server port (always on loopback) |
| `KESTREL_UI_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origins allowed to call the server |
| `KESTREL_DATA_DIR` | `~/.kestrel-dev` from this checkout, `~/.kestrel` in an installed app | Database, launch file, worktrees |
| `KESTREL_FAKE` | off | `1` opens a separate seeded fake store instead of the real one. Real sessions work in both |
| `KESTREL_DEMO` | off | `1` opens the demo workspace (`pnpm demo`): fake data with the rest of the app filled in, the scripted agent, a store of its own |
| `KESTREL_SETUP_PREVIEW` | off | `1` in a checkout: Set up this computer shows the list a new Mac would be shown for this computer's real set-up, with no account and no second computer. Nothing is uploaded |
| `KESTREL_ACCOUNT_PREVIEW` | off | `1` in a checkout: a second computer, Studio Mac, is put into this store's replica with its projects and sessions (`server/src/seed-account.ts`): one project this computer also has (by the repository key of its first project with an `origin`; none is shown when there is no such project), one it does not have with two sessions, one with none, and a plain folder. No account is needed and nothing is uploaded. Never active in the installed app |
| `KESTREL_SAMPLE_REVIEWS` | 9 | With fake data, how many sample review requests wait in CODE REVIEWS (up to 1000) |
| `KESTREL_SAMPLE_UNREAD` | all | With fake data, how many of those are unread (the most recent ones); the rest are marked read |
| `KESTREL_SAMPLE_TICKETS` | 6 | With fake data or the demo, how many tickets the sample tracker holds (up to 1000), to see a long list |
| `KESTREL_PERSISTENCE` | `sqlite` | `memory` keeps everything in memory |
| `KESTREL_NODE_PORT` | `4318` | The worker node's loopback port (`pnpm --filter @kestrel/server kestrel-node`); `0` takes any free one |
| `KESTREL_CRASH_DSN` | none | A test address for crash reports. A checkout never reports without it; with it, it reports there as `development` |
| `KESTREL_TEST_CRASH_REPORT` | off | `1` sends one crash report from the server at launch and prints whether it left |

## Test

```bash
pnpm test
```

```bash
pnpm --filter @kestrel/server typecheck
```

```bash
pnpm --filter @kestrel/ui build
```

## Layout

```
server/   Node + TypeScript. HTTP and WebSocket on loopback: the session store, filing rules,
          agent adapters, worktrees, pull requests and the tools agents are given.
  src/model.ts          Project / Session / Group / Link, and what the UI receives
  src/workspace.ts      Operations: handoff, delegate, move, limits; the cached derived state
  src/filing.ts         Where a session is filed, from git evidence (pure functions)
  src/tree.ts           How groups and links become sidebar rows
  src/agents/           One adapter per agent, and the tools every session gets
  src/persistence/      The storage facade and its providers (SQLite, in-memory)
  src/shared/           Pure rules used by the server and the UI alike
  src/http.ts           API routes and the state socket
  src/security.ts       Launch token, Origin and Host checks
ui/       React + TypeScript + Vite. Talks only to the server; works in a plain browser.
  src/store.ts          The one copy of server data, transport, drafts
  src/components/       Sidebar, conversation, panes
  src/pages/            What the main canvas shows
app/      The Electron shell: window, menus, updater, notifications, packaging.
scripts/  Release, demo and public-copy scripts.
Brand/    The icon and its exports.
```

## Releases

[RELEASING.md](RELEASING.md) describes the build: signing, notarization, the update feed.

