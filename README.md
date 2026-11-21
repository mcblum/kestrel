# Kestrel

A Mac app that runs Claude Code, Codex CLI and OpenCode sessions behind one interface, organized
around the task you are doing, not the repository you happen to be in.

You describe a task once. Kestrel gives each session its own git worktree, files it under the
project its changes really land in, and shows you which sessions are working and which are
waiting on you. A task that reaches several repositories is split into one session per project
and followed as one workstream.

## What it does

- **Three agents, one window.** Claude Code, Codex CLI and OpenCode run through their own SDKs
  and their own sign-ins on your computer. Kestrel has no agent loop of its own and never asks
  for an API key.
- **A worktree per session.** Sessions in a git project work in their own worktree and branch,
  so several can run in one repository at once. A plain folder works too, one editing session
  at a time.
- **Work across projects.** An agent can hand a task off to the project it belongs in, or
  delegate parts of it to sessions in other projects and report back. Edits stay in each
  project's own session.
- **Review in place.** Diffs, a terminal, a browser pane and an iOS simulator pane sit beside
  the conversation. Pull requests are created, followed and reviewed from the app, on GitHub
  and GitLab, including requests other people asked you to review.
- **Local only.** The server binds to loopback, every request carries a per-launch token, and
  nothing is hosted.

## Install

Kestrel ships as a signed, notarized app for Macs with Apple Silicon and updates itself:

[Download Kestrel.dmg](https://starfish.nationalmachine.io/kestrel/releases/-/releases/permalink/latest/downloads/Kestrel.dmg)

You need at least one of the agents installed and signed in: [Claude Code](https://claude.com/claude-code)
(`claude`, then `/login`), Codex CLI or OpenCode. For pull requests, `gh` or `glab` signed in to
your host. Setup on first launch checks all of this.

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
at once. (`~/.kestrel` is kept for an installed app; nothing run from this checkout opens it.) Quitting the app stops the server and any agents. To run the built UI instead of Vite:
`pnpm --filter @kestrel/ui build`, then `pnpm --filter @kestrel/app start`.

A signed, notarized `Kestrel.dmg` (Apple Silicon) is built by `scripts/release/make-release.sh`;
the installed app uses `~/.kestrel` and updates itself. See [RELEASING.md](RELEASING.md).

Tabs: ⌘N or ⌘T new session tab, ⌘W close tab, ⌘1–9 switch, ⌘K switch session. Right-click the
sidebar to add a project, folder or session. (Browsers reserve some of these shortcuts; the
buttons and the menu always work.)

The server makes a new access token every time it starts and writes it to
`~/.kestrel-dev/launch.json` (readable by you only). The Vite dev server hands that token
to the page; in the app the Electron shell makes the token and hands it over itself. If the
server restarts, an open page fetches the new token by itself.

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

To start again from clean fake data, run with `KESTREL_FAKE=1` and delete
`~/.kestrel-dev/kestrel-fake.sqlite*`. Worktrees live in `~/.kestrel-dev/worktrees/`.

| Variable | Default | Meaning |
|---|---|---|
| `KESTREL_PORT` | `4317` | Server port (always on loopback) |
| `KESTREL_UI_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origins allowed to call the server |
| `KESTREL_DATA_DIR` | `~/.kestrel-dev` from this checkout, `~/.kestrel` in an installed app | Database, launch file, worktrees |
| `KESTREL_FAKE` | off | `1` opens a separate seeded fake store instead of the real one. Real sessions work in both |
| `KESTREL_DEMO` | off | `1` opens the demo workspace (`pnpm demo`): fake data with the rest of the app filled in, the scripted agent, a store of its own |
| `KESTREL_PERSISTENCE` | `sqlite` | `memory` keeps everything in memory |

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

## This repository

Kestrel is developed on a private GitLab server; the copy on GitHub is published from there by
CI after each merge (`scripts/public/sync-github.sh`), as the source tree without the internal
design notes. Issues are welcome on GitHub. A pull request is welcome too, but it cannot be
merged there directly: an accepted change is applied upstream and arrives with the next sync.

## License

[GNU Affero General Public License, version 3](LICENSE). If you run a changed Kestrel for other
people, including as a service, you must offer them your changes under the same license.
