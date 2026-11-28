import { autopilotRoute } from './pull-requests/autopilot-api.ts';
import { WORKSTREAM_NAME_MAX, WORKSTREAM_OBJECTIVE_MAX } from './shared/workstreams.ts';
import { remoteWorkstreamRefusal } from './shared/account-workstreams.ts';
import { landingRoute, worktreesRoute } from './landing-api.ts';
// HTTP and WebSocket API. Thin: checks access, validates input, calls the Workspace.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { isSelectableAgent, SELECTABLE_AGENTS, type Agent, type ChatMessage, type Project, type SessionView } from './model.ts';
import { conversationStamp, notReachedRead, notReachedSettings, remoteRefusal, whereIsMachine, type Machine } from './shared/machines.ts';
import { notChangedHereRefusal, notHereRefusal } from './shared/account-projects.ts';
import { thisComputer } from './shared/platform.ts';
import { isPermissionLevel } from './shared/permissions.ts';
import { sanitize } from './shared/tabs.ts';
import { readFileSync } from 'node:fs';
import { attachmentRoute, draftRefs } from './attachments/api.ts';
import { Terminals } from './terminals.ts';
import { terminalFolder } from './scope-folder.ts';
import { scopeKey } from './shared/scope.ts';
import { terminalSocket, type TerminalMessage } from './terminal-socket.ts';
import { isBrowserMessage } from './browser-bridge.ts';
import { simRoute } from './sim-api.ts';
import { windowThingOf } from './window-routes.ts';
import { organizeRoute } from './organize-api.ts';
import { suggestionRoute } from './suggestions/api.ts';
import { gitSettingsRoute } from './git-settings/api.ts';
import { projectEditsRoute } from './project-edits/api.ts';
import { knowledgeRoute } from './knowledge/api.ts';
import { remoteStartsRoute } from './remote-starts/api.ts';
import { startRequestedReview } from './review-requests/start-requested.ts';
import { isBaseChoice, type BaseChoice } from './shared/start-base.ts';
import { startBaseRoute } from './start-base/api.ts';
import { keepAwakeRoute } from './keep-awake/api.ts';
import { whoDoesWhatRoute } from './who-does-what/api.ts';
import { cleanupPolicyRoute } from './cleanup/api.ts';
import { notificationsRoute } from './notifications/api.ts';
import { gitDefaultsRoute } from './git-defaults/api.ts';
import { savedActionsRoute } from './saved-actions/api.ts';
import { resolveAction, type PreviewWait } from './saved-actions/run.ts';
import { projectEnvRoute } from './project-env/api.ts';
import { mcpServersRoute } from './mcp-servers/api.ts';
import type { ProbeResult } from './mcp-servers/probe.ts';
import { projectScriptsRoute } from './project-scripts/api.ts';
import { commandsKeptRoute } from './commands-kept/api.ts';
import { delegationLimitsRoute } from './limits-api.ts';
import { quitCheckNow } from './quit-check-now.ts';
import { commitSigningRoute } from './commit-signing/api.ts';
import { crashReportsRoute } from './crash-reports/api.ts';
import { whatsNewRoute } from './whats-new/api.ts';
import type { NotesSource } from './whats-new/notes.ts';
import type { WhatsNew } from './whats-new/store.ts';
import type { CrashReportSetup } from './shared/crash-reports.ts';
import { sandboxAllowRoute } from './sandbox-allow/api.ts';
import { projectRoute } from './project-api.ts';
import { projectPath } from './shared/project-folders.ts';
import { detailsSources, type DetailsSources } from './details-api.ts';
import { asReviewOrder } from './shared/review-requests.ts';
import type { ReviewRequestStore } from './review-requests/store.ts';
import { ticketsRoute, type TicketsApi } from './tickets/api.ts';
import { reviewSettingsRoute } from './review-settings/api.ts';
import { coloursRoute } from './colours/api.ts';
import { pullRequestListRoute } from './pull-request-list-api.ts';
import type { TitleProvider } from './agents/title-providers.ts';
import { onboardingRoute } from './onboarding/api.ts';
import { controlsRoute, speedFields } from './controls-api.ts';
import { signInRoute } from './sign-in-api.ts';
import { connectRoute } from './connect/link/api.ts';
import type { KestrelConnect } from './connect/link/connect.ts';
import { fileOpenRoute, runCommand, type FileOpenDeps } from './file-open-api.ts';
import { appIcons } from './app-icons.ts';
import { hostPlatform } from './host.ts';
import { openersFor, type Openers } from './openers.ts';
import { isSimMessage, simSocket } from './sim-socket.ts';
import { userMcpServers } from './claude-config.ts';
import { isArchiveKind } from './shared/archive.ts';
import { publicInfo } from './shared/setup.ts';
import { switchableServers } from './shared/mcp-servers.ts';
import { sanitizeSidebar } from './shared/sidebar.ts';
import { checkPage } from './shared/connect-ops.ts';
import { pageRefusal, transcriptPage, type PageAsk } from './shared/transcript-page.ts';
import { mayBeAhead, RemoteConversations } from './remote-conversation.ts';
import { chosenFolderHere, folderHere } from './account-project-here.ts';
import { createProject, existingFolder } from './project-store.ts';
import { remoteActionRoute, type ActionAnswer, type RemoteActionDeps } from './remote-actions.ts';
import { remoteStartRoute, type StartComputers } from './remote-start.ts';
import { asStartChoices, unreachableStart, type StartComputerAnswer } from './shared/start-computer.ts';
import { checkAccess, LOOPBACK_HOST, type AccessPolicy } from './security.ts';
import { mcpSessionOf, serveSessionMcp } from './kestrel-mcp.ts';
import { LiveChannel } from './live-channel.ts';
import { ASIDE_KEY_MAX, checkSubject } from './shared/asides.ts';
import { FINDING_ACTIONS, isFindingAction } from './finding-actions.ts';
import { isReviewEndAction, REVIEW_END_ACTIONS } from './review-end.ts';
import type { SessionRuntime } from './runtime.ts';
import { Refused, type Workspace } from './workspace.ts';
import { BadRequest, decodedSegment, optionalId, str } from './request-fields.ts';
import { scopeFiles, sessionRoutes, type SessionRoutes } from './session-routes.ts';

const MAX_BODY_BYTES = 64 * 1024;
/** Writes that land within this window go out as one broadcast. */
const BROADCAST_COALESCE_MS = 15;

/** Effort and fast mode from a body (controls-api.ts), a bad value as a 400. */
function speed(body: Record<string, unknown>): ReturnType<typeof speedFields> {
  try {
    return speedFields(body);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
}

/** The answers of a question card: question text -> chosen label(s). */
function answersOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequest('answers must be an object of question -> answer');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) throw new BadRequest('answers has too many questions');
  for (const [q, a] of entries) {
    if (q.length > 500) throw new BadRequest('a question in answers is too long');
    if (typeof a !== 'string' || a.length > 2000) throw new BadRequest('each answer must be text of at most 2000 characters');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** A message's text, which may be empty when it carries files. */
function messageText(value: unknown, field: string, hasFiles: boolean): string {
  if (hasFiles && (value === undefined || value === null || value === '')) return '';
  return str(value, field, 20_000);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('Body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new BadRequest('Body must be a JSON object');
  }
}

export interface KestrelServer {
  server: Server;
  /** Some window is connected: the PR store's background refresh runs only then (pull-request-sync.ts). */
  watched(): boolean;
  /** Some window has this session open: its pull requests are asked about every few seconds. */
  watching(sessionId: string): boolean;
  listen(): Promise<void>;
  /** The port really bound: the one asked for, or the free one found for port 0. Right once `listen` has answered. */
  port(): number;
  close(): Promise<void>;
}

export interface KestrelServerOptions {
  /** The user's shells; tests pass one with a stand-in pty. */
  terminals?: Terminals;
  /** How a saved action's preview address is waited for (saved-actions/run.ts); tests pass a stand-in. */
  actionPreview?: PreviewWait;
  /** Where the Details pane's pull requests come from; `sample` for the fake store. Default: the real sources. */
  details?: { sources: DetailsSources; sample: boolean };
  /** The requests the user was asked to review, pushed to every window (review-requests/store.ts). */
  reviewRequests?: ReviewRequestStore;
  /** The user's tickets, pushed to every window, and their routes (tickets/). */
  tickets?: TicketsApi;
  /** Kestrel Connect: its Settings routes, and its state pushed to every window (connect/link/). */
  connect?: KestrelConnect;
  /**
   * The computers a New session may run on and how they are asked (issue 52). Absent: Kestrel Connect's, the
   * account's other desktops over the sealed channel. Only the account preview of a checkout passes its own.
   */
  startComputers?: StartComputers;
  /** How long a start on another computer waits for its answer; `START_TIMEOUT_MS` unless a test makes it shorter. */
  startTimeoutMs?: number;
  /** How this copy reports its own failures, or null when it never does (shared/crash-reports.ts). Default: never. */
  crashReporting?: CrashReportSetup | null;
  /** What's new: the notes this copy carries and the record of what was shown, pushed to every window (whats-new/). */
  whatsNew?: { store: WhatsNew; notes: NotesSource };
  /** Who may write a generated pull request's text: the title providers (index.ts). Default: none. */
  writers?: readonly TitleProvider[];
  /** The session page's routes, shared with what another desktop asks (session-routes.ts). Default: built here. */
  sessionRoutes?: SessionRoutes;
  /** How files are opened and shown in the file manager (file-open-api.ts); tests pass a stand-in runner. Default: this computer's own way (openers.ts). */
  /** Settings' Test for an MCP server (mcp-servers/probe.ts); tests pass a stand-in. Default: the real one. */
  mcpProbe?: (config: Record<string, unknown>) => Promise<ProbeResult>;
  fileOpen?: Partial<Pick<FileOpenDeps, 'run' | 'editors' | 'canOpen' | 'folderApps' | 'folderAppIcons' | 'platform' | 'launch'>>;
}

export function createKestrelServer(workspace: Workspace, givenPolicy: AccessPolicy, runtime?: SessionRuntime, options: KestrelServerOptions = {}): KestrelServer {
  // Port 0 asks for any free port: the Host check and the MCP endpoints use the one really bound, so the policy is this server's own copy.
  const policy: AccessPolicy = { ...givenPolicy };
  // A session another computer runs is watched there while some window here watches it (remote-sessions.ts).
  const live = new LiveChannel((id, watched) => void watchElsewhere(id, watched));
  const unsubscribeLive = runtime?.onLive((id, patch) => live.publish(id, patch));
  const unsubscribeRemote = options.connect?.remote.onLive((id, patch) => live.publish(id, patch));
  const send = (req: IncomingMessage, res: ServerResponse, status: number, body?: unknown) => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    const origin = req.headers.origin;
    if (origin && policy.allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    }
    if (body === undefined) {
      res.writeHead(status, headers).end();
      return;
    }
    headers['Content-Type'] = 'application/json';
    res.writeHead(status, headers).end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  /** Bytes (a picture) with the same headers as `send`. */
  const sendBytes = (req: IncomingMessage, res: ServerResponse, type: string, bytes: Buffer) => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Content-Type': type, 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff' };
    const origin = req.headers.origin;
    if (origin && policy.allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(200, headers).end(bytes);
  };

  // The state is serialized once per change and the same string goes to every reader.
  let stateJson: Promise<string> | null = null;
  const detailsConfig = options.details ?? { sources: detailsSources(false), sample: false };
  const sessionPage = options.sessionRoutes ?? sessionRoutes({ workspace, runtime: runtime ?? null, details: detailsConfig, writers: options.writers ?? [] });
  // Found once: which apps are installed does not change while Kestrel runs.
  let found: Openers | null = null;
  const openers = (): Openers => (found ??= openersFor(options.fileOpen?.platform ?? hostPlatform()));
  let folderAppIcons: Promise<Record<string, string>> | null = null;
  const fileOpen: Omit<FileOpenDeps, 'directoryOf' | 'folderOf' | 'openIn'> = {
    // Read once: an app's icon does not change while Kestrel runs.
    // An app's own icon is read from its bundle, which only a Mac has: elsewhere the menu shows names alone.
    folderAppIcons: options.fileOpen?.folderAppIcons ?? (() => (folderAppIcons ??= openers().platform === 'mac' ? appIcons(fileOpen.folderApps().map((a) => ({ id: a.id, app: a.iconApp ?? a.app }))) : Promise.resolve({}))),
    folderApps: options.fileOpen?.folderApps ?? (() => openers().folderApps),
    run: options.fileOpen?.run ?? runCommand,
    editors: options.fileOpen?.editors ?? (() => openers().editors),
    canOpen: options.fileOpen?.canOpen ?? true,
    platform: options.fileOpen?.platform ?? hostPlatform(),
    launch: options.fileOpen?.launch ?? { openFile: (editor, file) => openers().openFile(editor, file), reveal: (target) => openers().reveal(target), openFolder: (app, folder) => openers().openFolder(app, folder) },
  };
  // A window is sent this computer's sessions and the account's other computers' (`Workspace.view`).
  const currentStateJson = () => (stateJson ??= workspace.view().then((s) => JSON.stringify(s)));

  /** A session that runs on another computer of the account, with that machine; null for this computer's own, and for none. */
  async function remoteSession(id: string): Promise<{ session: SessionView; machine: Machine; archived: boolean } | null> {
    const view = await workspace.view();
    if (!view.machines) return null;
    // An archived one too: it is restored, or opened from Archived, through its machine.
    const shown = view.sessions.find((s) => s.id === id && s.runsOn);
    const session = shown ?? view.archived.sessions.find((s) => s.id === id && s.runsOn);
    if (!session?.runsOn) return null;
    return { session, machine: whereIsMachine(session.runsOn, view.machines), archived: !shown };
  }

  /** A project another computer of the account has and no folder of this one is (account-view.ts), or null. */
  async function awayProject(id: unknown): Promise<Project | null> {
    if (typeof id !== 'string' || id.length === 0) return null;
    return (await workspace.view()).projects.find((p) => p.id === id && p.away) ?? null;
  }
  const here = () => thisComputer(options.fileOpen?.platform ?? hostPlatform());

  /**
   * Remote conversations: the account's copy at once, the other computer asked only when it may have more, and
   * what it answers sent on the session's live channel (remote-conversation.ts).
   */
  const remoteConversations = new RemoteConversations({
    read: options.connect ? (machine, id, page, opts) => options.connect!.remote.read(machine, id, page, opts) : null,
    kept: async (id) => {
      const kept = await options.connect?.replica?.conversation(id);
      if (kept) return { messages: kept.messages, current: kept.current, readAt: kept.readAt, stamp: conversationStamp(kept.head), ...(kept.head.settings ? { settings: kept.head.settings } : {}) };
      // No account link here: the copy is whatever was kept, current when it was read whole at its head's stamp.
      const [head, mark] = await Promise.all([workspace.account.head(id), workspace.account.detailMark(id)]);
      const stamp = head ? conversationStamp(head) : undefined;
      return { messages: await workspace.account.messages(id), current: stamp !== undefined && mark?.stamp === stamp, readAt: mark?.readAt ?? null, ...(stamp ? { stamp } : {}), ...(head?.settings ? { settings: head.settings } : {}) };
    },
    publish: (id, messages) => live.publish(id, { messages }),
  });

  /** Its conversation, whole or a page; `again` when the person pressed Try again. */
  function remoteRead(found: { session: SessionView; machine: Machine; archived?: boolean }, ask: PageAsk | null, again: boolean) {
    return remoteConversations.detail(found.session, found.machine, ask, again, found.archived === true);
  }

  /**
   * A session another computer just made from one of its own at this window's word (a fork): listed here at once, from
   * the head it was made from, until its own head arrives in the change feed (as a start elsewhere is, remote-start.ts).
   */
  async function listedThere(machine: Machine, fromId: string, made: Record<string, unknown>): Promise<void> {
    const from = await workspace.account.head(fromId);
    if (!from || typeof made.id !== 'string' || !made.id) return;
    const now = Date.now();
    const title = typeof made.title === 'string' && made.title ? made.title : from.title;
    const { hostId: _guestOf, ...head } = from;
    await workspace.account.started(machine, { ...head, id: made.id, title, state: 'running', note: '', request: null, stopped: undefined, completedAt: undefined, createdAt: now, updatedAt: now, lastActivityAt: now, messages: 0, chunks: 0 });
  }

  /** How a session on another computer is acted on there, or null with no account to ask through. */
  function remoteDeps(): RemoteActionDeps | null {
    const remote = options.connect?.remote;
    return remote ? { ask: (machine, op, args) => remote.ask(machine, op, args), drafts: runtime?.attachments ?? null, listed: listedThere } : null;
  }

  /** The account's other computers a session may be started on from here, and how each is asked; none with no account. */
  const startSource: StartComputers | null = options.startComputers ?? (options.connect ? { list: () => options.connect!.otherComputers(), ask: (machine, op, args, opts) => options.connect!.remote.ask(machine, op, args, opts) } : null);
  const otherComputers = (): Machine[] => startSource?.list() ?? [];

  /** A New session sent to another computer of the account (remote-start.ts), or refused with why it cannot go. */
  async function startElsewhere(body: Record<string, unknown>): Promise<ActionAnswer> {
    const machine = typeof body.machine === 'string' ? otherComputers().find((m) => m.id === body.machine) : undefined;
    const deps = startSource ? { ask: startSource.ask, drafts: runtime?.attachments ?? null } : null;
    if (!machine || !deps) return { status: 409, body: { error: 'That computer is not one of your account’s, or Kestrel Connect is not connected. Start the session here, or try again when it is.' } };
    return remoteStartRoute(body, machine, {
      ...deps,
      projects: (await workspace.view()).projects,
      reposOf: (project) => workspace.repos.ofProject(project),
      started: (m, head) => workspace.account.started(m, head),
      now: Date.now,
      // What it published it offers: where a project it would clone is found (a worker node, item 64).
      offersOf: async (m) => (await workspace.accountOffers.view())[m.id]?.offers ?? null,
      ...(options.startTimeoutMs ? { startTimeoutMs: options.startTimeoutMs } : {}),
    });
  }

  /** What another computer offers a New session from here: its published record, else its live `session.startChoices`; or why neither. */
  async function startChoicesOf(id: string): Promise<StartComputerAnswer> {
    const machine = otherComputers().find((m) => m.id === id);
    if (!machine || !startSource) return { ok: false, reason: 'That computer is not one of your account’s any more.' };
    // What it published on Kestrel Connect, read from this computer's own copy: at once, and whether or not it is
    // awake. It is asked directly only when it has published nothing (a Kestrel from before it did).
    const published = (await workspace.accountOffers.view())[machine.id];
    if (published) return { ok: true, choices: published.offers };
    const answer = await startSource.ask(machine.id, 'session.startChoices', {});
    if (!answer.ok) return { ok: false, reason: answer.reached ? answer.reason : unreachableStart(machine.name) };
    const choices = asStartChoices(answer.result);
    return choices ? { ok: true, choices } : { ok: false, reason: `${machine.name} answered with something Kestrel cannot read. Update Kestrel there.` };
  }

  /** Sessions some window watches that run on another computer: their machine is asked to send live output while they may. */
  const watchedElsewhere = new Set<string>();

  /**
   * The first window began watching a session, or the last stopped: when another computer runs it, it is told. That
   * computer is asked only while the session runs or waits on the person (the rule: it is asked only for what only it
   * has); a finished one is read from the account's copy, and asked again when a turn starts (`rewatchElsewhere`).
   */
  async function watchElsewhere(id: string, watched: boolean): Promise<void> {
    const remote = options.connect?.remote;
    if (!remote) return;
    if (!watched) {
      watchedElsewhere.delete(id);
      return remote.unwatch(id);
    }
    const found = await remoteSession(id);
    if (!found) return;
    const first = !watchedElsewhere.has(id);
    watchedElsewhere.add(id);
    // Opened in a window: what its page draws beside the conversation, and that computer's pull requests, asked once.
    if (first) {
      void remote.readPullRequests(found.machine.id);
      void remote.snapshot(found.machine.id, id).then((answer) => {
        // The model and mode row says why too, rather than vanishing (issue 79); null once that computer answered.
        if (answer.ok) live.publish(id, { unreached: null });
        else live.publish(id, { filesProblem: answer.reached ? answer.reason : notReachedRead('its changes', found.machine.name), unreached: answer.reached ? answer.reason : notReachedSettings(found.machine.name) });
      });
    }
    // Still watched once found: a window that closed meanwhile asks for nothing.
    if (live.isWatched(id) && !remote.watching(id) && mayBeAhead(found.session)) remote.watch(found.machine.id, id);
  }

  /** The account's sessions changed: a watched one whose turn started there is asked for its live output now. */
  async function rewatchElsewhere(): Promise<void> {
    for (const id of watchedElsewhere) await watchElsewhere(id, true);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', ':id', 'move']
    const method = req.method ?? 'GET';
    if (parts[0] !== 'api') return send(req, res, 404, { error: 'Not found' });

    // What needs a screen is refused on a computer with none, with the reason (window-routes.ts).
    const windowThing = windowThingOf(parts, method);
    const noScreen = windowThing && runtime ? runtime.noWindow[windowThing] : null;
    if (noScreen) throw new Refused(noScreen);

    // A session another computer runs is read here and acted on there (remote-actions.ts): a route with an
    // operation of the closed list is asked of that computer, anything else is refused saying where it runs
    // (shared/machines.ts), before any route can take its id for one of this computer's.
    const elsewhere = parts[1] === 'sessions' && parts[2] ? await remoteSession(decodedSegment(parts[2])) : null;
    if (elsewhere && !(method === 'GET' && parts.length === 3)) {
      const deps = remoteDeps();
      if (!deps) return send(req, res, 409, { error: remoteRefusal(elsewhere.machine.name) });
      const answer = await remoteActionRoute(parts, method, () => readJson(req), elsewhere.session.id, elsewhere.machine, deps, url);
      return 'bytes' in answer ? sendBytes(req, res, answer.type, answer.bytes) : send(req, res, answer.status, answer.body);
    }

    // The computers a New session may run on (issue 52): the account's others, and what each offers when asked.
    if (method === 'GET' && parts[1] === 'start-computers') {
      if (parts.length === 2) return send(req, res, 200, { computers: otherComputers() });
      if (parts.length === 3) return send(req, res, 200, await startChoicesOf(decodedSegment(parts[2]!)));
    }

    // A project not on this computer is listed, and nothing here may act on it as one of its own (account-sessions.md, 10.2).
    const notHere = parts[1] === 'projects' && parts[2] && method !== 'GET' ? await awayProject(decodedSegment(parts[2])) : null;
    // The one thing done to it here: the folder of this computer that is its repository becomes a project.
    if (notHere && method === 'POST' && parts.length === 4 && parts[3] === 'here') {
      const path = await chosenFolderHere(notHere, existingFolder(str((await readJson(req)).path, 'path', 4096)));
      return send(req, res, 200, await createProject(workspace, { name: notHere.name, folders: [path] }));
    }
    if (notHere) return send(req, res, 409, { error: notChangedHereRefusal(notHere, here()) });

    if (method === 'GET' && parts[1] === 'state' && parts.length === 2) return send(req, res, 200, await currentStateJson());
    // The shell's quit check (app/quit-guard.mjs): what quitting would stop, by the one rule (shared/quit-check.ts).
    if (method === 'GET' && parts[1] === 'quit-check' && parts.length === 2) return send(req, res, 200, await quitCheckNow(workspace, runtime ? (id) => runtime.overlay(id) : null));

    const connected = options.connect ? await connectRoute(parts, method, () => readJson(req), options.connect, workspace.accountOffers) : null;
    if (connected) return send(req, res, connected.status, connected.body);

    const onboarding = await onboardingRoute(parts, method, () => readJson(req), workspace.onboarding);
    if (onboarding) return send(req, res, onboarding.status, onboarding.body);

    // The simulator pane (sim-api.ts).
    const sim = runtime ? await simRoute(parts, method, () => readJson(req), runtime) : null;
    if (sim) return send(req, res, sim.status, sim.body);
    // Tags and pins (organize-api.ts).
    const organized = await organizeRoute(parts, method, () => readJson(req), workspace);
    if (organized) return send(req, res, organized.status, organized.body);
    // Optional actions the agent dropped in, and the user's standing answers to them (suggestions/api.ts).
    const suggested = runtime ? await suggestionRoute(parts, method, () => readJson(req), runtime.suggestions) : null;
    if (suggested) return send(req, res, suggested.status, suggested.body);
    // Settings → Git: the branch name prefix (git-settings/api.ts).
    const gitSettings = runtime ? await gitSettingsRoute(parts, method, () => readJson(req), runtime.gitPrefs) : null;
    if (gitSettings) return send(req, res, gitSettings.status, gitSettings.body);
    // Where a new session starts when the checkout is not on its default branch (start-base/api.ts).
    const startBase = runtime ? await startBaseRoute(parts, method, () => readJson(req), workspace, runtime.startBase, (projectId) => runtime.gitDefaults.of(projectId)) : null;
    if (startBase) return send(req, res, startBase.status, startBase.body);
    // A project's setup and archive scripts (project-scripts/api.ts).
    const projectScripts = runtime ? await projectScriptsRoute(parts, method, () => readJson(req), workspace, runtime.projectScripts.scripts) : null;
    if (projectScripts) return send(req, res, projectScripts.status, projectScripts.body);
    // Settings → Workflow → Keep awake (keep-awake/api.ts).
    const keepAwake = runtime ? await keepAwakeRoute(parts, method, () => readJson(req), runtime.keepAwake) : null;
    if (keepAwake) return send(req, res, keepAwake.status, keepAwake.body);
    // The model presets and the "Who does what" table (who-does-what/api.ts).
    const whoDoesWhat = runtime ? await whoDoesWhatRoute(parts, method, () => readJson(req), runtime.whoDoesWhat) : null;
    if (whoDoesWhat) return send(req, res, whoDoesWhat.status, whoDoesWhat.body);
    // What is done when a pull request is merged (cleanup/api.ts).
    const cleanup = runtime ? await cleanupPolicyRoute(parts, method, () => readJson(req), workspace, runtime.cleanupPrefs) : null;
    if (cleanup) return send(req, res, cleanup.status, cleanup.body);
    // Settings → Workflow → Notifications (notifications/api.ts).
    const notifications = runtime ? await notificationsRoute(parts, method, () => readJson(req), runtime.notifications) : null;
    if (notifications) return send(req, res, notifications.status, notifications.body);
    // A project's base branch and remote (git-defaults/api.ts).
    const gitDefaults = runtime ? await gitDefaultsRoute(parts, method, url.searchParams, () => readJson(req), workspace, runtime.gitDefaults) : null;
    if (gitDefaults) return send(req, res, gitDefaults.status, gitDefaults.body);
    // A project's saved actions (saved-actions/api.ts).
    const savedActions = runtime ? await savedActionsRoute(parts, method, () => readJson(req), workspace, runtime.savedActions) : null;
    if (savedActions) return send(req, res, savedActions.status, savedActions.body);
    // Variables, .env files and files copied into new worktrees (project-env/api.ts).
    const projectEnv = runtime ? await projectEnvRoute(parts, method, () => readJson(req), workspace, runtime.projectEnv) : null;
    if (projectEnv) return send(req, res, projectEnv.status, projectEnv.body);
    // Kestrel's own list of MCP servers: add, change, remove, Test (mcp-servers/api.ts). No answer carries a secret value.
    const mcp = runtime ? await mcpServersRoute(parts, method, () => readJson(req), runtime.mcpServers ? { store: runtime.mcpServers, ...(options.mcpProbe ? { probe: options.mcpProbe } : {}) } : undefined) : null;
    if (mcp) return send(req, res, mcp.status, mcp.status === 204 ? undefined : mcp.body);
    // Settings → Workflow: how many commands each session keeps (commands-kept/api.ts).
    const commandsKept = runtime ? await commandsKeptRoute(parts, method, () => readJson(req), runtime.commandsKept) : null;
    if (commandsKept) return send(req, res, commandsKept.status, commandsKept.body);
    // Settings → Git: what is done with the requests the user was asked to review (review-settings/api.ts).
    const reviewSettings = runtime ? await reviewSettingsRoute(parts, method, () => readJson(req), workspace, runtime.reviewPrefs) : null;
    if (reviewSettings) return send(req, res, reviewSettings.status, reviewSettings.body);
    // Settings → Colours: the review and workstream colours, and each tag's (colours/api.ts).
    const colours = runtime ? await coloursRoute(parts, method, () => readJson(req), runtime.colours) : null;
    if (colours) return send(req, res, colours.status, colours.body);
    // Settings → Workflow: keeping each project's edits in its own session (project-edits/api.ts).
    const projectEdits = runtime ? await projectEditsRoute(parts, method, () => readJson(req), runtime.projectEdits) : null;
    if (projectEdits) return send(req, res, projectEdits.status, projectEdits.body);
    const knowledge = runtime ? await knowledgeRoute(parts, method, () => readJson(req), runtime.knowledge) : null;
    if (knowledge) return send(req, res, knowledge.status, knowledge.body);
    // Settings → Workflow: whether other devices of the account may start sessions here (remote-starts/api.ts).
    const remoteStarts = runtime ? await remoteStartsRoute(parts, method, () => readJson(req), runtime.remoteStarts) : null;
    if (remoteStarts) return send(req, res, remoteStarts.status, remoteStarts.body);
    // Settings → Workflow: letting a confined session's signed commits through its sandbox (commit-signing/api.ts).
    const signing = runtime ? await commitSigningRoute(parts, method, () => readJson(req), runtime.commitSigning) : null;
    if (signing) return send(req, res, signing.status, signing.body);
    // Settings → General: reporting Kestrel's own failures (crash-reports/api.ts).
    const crashReports = runtime ? await crashReportsRoute(parts, method, () => readJson(req), runtime.crashReports, options.crashReporting ?? null) : null;
    if (crashReports) return send(req, res, crashReports.status, crashReports.body);
    // What's new: the notes by release, their pictures, the switch, and "shown" (whats-new/api.ts).
    const whatsNew = options.whatsNew ? await whatsNewRoute(parts, method, () => readJson(req), options.whatsNew.store, options.whatsNew.notes) : null;
    if (whatsNew) return 'bytes' in whatsNew ? sendBytes(req, res, whatsNew.type, whatsNew.bytes) : send(req, res, whatsNew.status, whatsNew.body);
    // Settings → Workflow: the delegation limits (limits-api.ts).
    const limits = await delegationLimitsRoute(parts, method, () => readJson(req), workspace.limits);
    if (limits) return send(req, res, limits.status, limits.body);
    // Settings → Workflow: commands and folders always allowed outside the sandbox (sandbox-allow/api.ts).
    const sandboxAllow = runtime ? await sandboxAllowRoute(parts, method, () => readJson(req), runtime.sandboxAllow) : null;
    if (sandboxAllow) return send(req, res, sandboxAllow.status, sandboxAllow.body);
    // Projects and their directories (project-api.ts).
    const projectAnswer = await projectRoute(parts, method, url, () => readJson(req), workspace, runtime);
    if (projectAnswer) return send(req, res, projectAnswer.status, projectAnswer.body);
    const autopilotAnswer = await autopilotRoute(parts, method, () => readJson(req), runtime?.autopilot ?? null);
    if (autopilotAnswer) return send(req, res, autopilotAnswer.status, autopilotAnswer.body);
    // Merging a session's worktree locally, or discarding it (landing-api.ts).
    const worktrees = await worktreesRoute(parts, method, url.searchParams.get('refresh') === '1', () => readJson(req), runtime ?? null);
    if (worktrees) return send(req, res, worktrees.status, worktrees.body);
    const landed = await landingRoute(parts, method, () => readJson(req), runtime ?? null);
    if (landed) return send(req, res, landed.status, landed.body);
    // A session's page beside its conversation: Details, files, documents, the queue, commands, the request form and
    // merge, rename, delete, tags, roles, review and fork (session-routes.ts; another desktop asks the same function).
    const sessionAnswer = await sessionPage.route(parts, method, url, () => readJson(req));
    if (sessionAnswer) return 'bytes' in sessionAnswer ? sendBytes(req, res, sessionAnswer.type, sessionAnswer.bytes) : send(req, res, sessionAnswer.status, sessionAnswer.body);
    // The order the user dragged the CODE REVIEWS rows into (review-requests/store.ts).
    if (parts[1] === 'review-requests' && parts[2] === 'order' && parts.length === 3 && method === 'PUT') {
      const order = asReviewOrder((await readJson(req)).order);
      if (!order || !options.reviewRequests) return send(req, res, 400, { error: 'order must be a list of request keys.' });
      options.reviewRequests.setOrder(order);
      return send(req, res, 204, null);
    }
    // Dismiss requests the user was asked to review, or restore dismissed ones (review-requests/store.ts).
    if (parts[1] === 'review-requests' && parts[2] === 'dismissed' && parts.length === 3 && method === 'PUT') {
      const body = await readJson(req);
      const keys = asReviewOrder(body.keys);
      if (!keys || typeof body.dismissed !== 'boolean' || !options.reviewRequests) return send(req, res, 400, { error: 'Give keys, a list of request keys, and dismissed, true or false.' });
      options.reviewRequests.dismiss(keys, body.dismissed);
      return send(req, res, 200, { ok: true });
    }
    // Mark requests read, or unread again (review-requests/store.ts).
    if (parts[1] === 'review-requests' && parts[2] === 'seen' && parts.length === 3 && method === 'PUT') {
      const body = await readJson(req);
      const keys = asReviewOrder(body.keys);
      if (!keys || typeof body.seen !== 'boolean' || !options.reviewRequests) return send(req, res, 400, { error: 'Give keys, a list of request keys, and seen, true or false.' });
      options.reviewRequests.markSeen(keys, body.seen);
      return send(req, res, 200, { ok: true });
    }
    // Tickets: dismiss, mark read, a ticket's detail, Work this ticket (tickets/api.ts).
    const ticketAnswer = await ticketsRoute(parts, method, url, () => readJson(req), options.tickets);
    if (ticketAnswer) return send(req, res, ticketAnswer.status, ticketAnswer.body);
    // Start reviewing a request the user was asked to review, or open the review already started (review-requests/start.ts).
    if (parts[1] === 'review-requests' && parts[2] === 'start' && parts.length === 3 && method === 'POST') {
      if (!runtime || !options.reviewRequests) return send(req, res, 409, { error: 'Reviews need a running agent runtime.' });
      const key = str((await readJson(req)).key, 'key', 400);
      return send(req, res, 201, await startRequestedReview(options.reviewRequests, (request, opts) => runtime.startReview(request, opts), key));
    }
    // The workspace's Pull requests page: every linked request, de-duplicated (pull-request-list-api.ts).
    const requestList = await pullRequestListRoute(parts, method, url, workspace, detailsConfig.sources, detailsConfig.sample);
    if (requestList) return send(req, res, requestList.status, requestList.body);
    // Signing an agent in from Kestrel (sign-in-api.ts).
    const signedIn = await signInRoute(parts, method, () => readJson(req), runtime ?? null);
    if (signedIn) return send(req, res, signedIn.status, signedIn.body);
    // What an agent offers the controls under the message box, and a session's context window (controls-api.ts).
    const controls = await controlsRoute(parts, method, runtime ?? null);
    if (controls) return send(req, res, controls.status, controls.body);
    // Opening a session's file in an editor, or showing it in Finder (file-open-api.ts).
    const opened = runtime ? await fileOpenRoute(parts, method, () => readJson(req), { ...fileOpen, directoryOf: (id) => runtime.directoryOf(id), folderOf: (scope) => runtime.folderOf(scope), openIn: runtime.openIn }) : null;
    if (opened) return send(req, res, opened.status, opened.body);
    // Files the user attaches to messages (attachments/api.ts).
    const attached = runtime ? await attachmentRoute(parts, method, req, url, runtime.attachments) : null;
    if (attached) return 'bytes' in attached ? sendBytes(req, res, attached.type, attached.bytes) : send(req, res, attached.status, attached.body);

    if (parts[1] === 'sessions') {
      if (method === 'GET' && parts.length === 3) {
        // `?last=N`, or `?before=<message>&limit=N`: one page of the conversation (shared/transcript-page.ts). Without them, all of it, as before.
        // `?again=1`: the person pressed Try again on a session another computer runs.
        const asked = ['last', 'before', 'limit'].filter((k) => url.searchParams.has(k));
        const ask = asked.length === 0 ? null : checkPage(Object.fromEntries(asked.map((k) => [k, k === 'before' ? url.searchParams.get(k) : Number(url.searchParams.get(k))])));
        if (ask && !ask.ok) throw new BadRequest(ask.reason);
        if (elsewhere) {
          const answer = await remoteRead(elsewhere, ask?.value ?? null, url.searchParams.get('again') === '1');
          return send(req, res, answer.status, answer.body);
        }
        const detail = await workspace.detail(parts[2]!);
        if (!detail) return send(req, res, 404, { error: 'No such session' });
        const whole = { ...detail, ...runtime?.overlay(parts[2]!) };
        if (!ask) return send(req, res, 200, whole);
        const refusal = pageRefusal(whole.messages, ask.value);
        if (refusal) return send(req, res, 404, { error: refusal });
        const page = transcriptPage(whole.messages, ask.value);
        return send(req, res, 200, { ...whole, messages: page.messages, page: { before: page.before, total: page.total } });
      }
      // A picture a tool returned, stored under the session's media folder.
      if (runtime && method === 'GET' && parts.length === 5 && parts[3] === 'media') {
        const media = runtime.display.mediaFile(parts[2]!, parts[4]!);
        if (!media) return send(req, res, 404, { error: 'No such picture' });
        return sendBytes(req, res, media.type, readFileSync(media.path));
      }
      if (method === 'POST' && parts.length === 2) {
        const body = await readJson(req);
        // The New session box named another computer of the account: started there (remote-start.ts, issue 52).
        if (body.machine !== undefined && body.machine !== null) {
          const answer = await startElsewhere(body);
          return send(req, res, answer.status, answer.body);
        }
        const startIn = await awayProject(body.projectId);
        if (startIn) return send(req, res, 409, { error: notHereRefusal(startIn, here()) });
        const agent = body.agent as Agent;
        if (!isSelectableAgent(agent)) throw new BadRequest(`agent must be ${SELECTABLE_AGENTS.join(', ')}`);
        if (runtime) {
          const model = body.model === undefined ? undefined : str(body.model, 'model', 80);
          if (body.permission !== undefined && !isPermissionLevel(body.permission)) throw new BadRequest('permission must be auto, ask, edits, plan, readonly or bypass');
          const draft = draftRefs(body);
          if (body.base !== undefined && !isBaseChoice(body.base)) throw new BadRequest('base must be "default" or "current"');
          if (body.rememberBase !== undefined && typeof body.rememberBase !== 'boolean') throw new BadRequest('rememberBase must be true or false');
          const base = body.base === undefined ? {} : { base: body.base as BaseChoice, rememberBase: body.rememberBase === true };
          const session = await runtime.start({ agent, projectId: optionalId(body.projectId, 'projectId'), folderId: optionalId(body.folderId, 'folderId'), prompt: messageText(body.prompt, 'prompt', draft !== null), draft, model, permission: body.permission as never, ...speed(body), ...(body.modelChosen === true ? { modelChosen: true } : {}), groupId: optionalId(body.groupId, 'groupId'), ...base, ...(body.purpose === 'setup' ? { purpose: 'setup' as const } : {}), byUser: true });
          return send(req, res, 201, session);
        }
        const session = await workspace.addSession({
          title: str(body.title, 'title'),
          agent,
          startedIn: optionalId(body.projectId, 'projectId'),
          groupId: optionalId(body.groupId, 'groupId'),
          state: 'running',
          note: 'Preview session · no agent attached yet',
        });
        return send(req, res, 201, session);
      }
      // A review of the session's work by the Review role's agent (delegation.ts `startReview`): where it stands, and starting one.
      // Post a review of somebody else's pull request, as the user left its card (review-requests/reply.ts).
      if (runtime && parts[3] === 'review-reply' && parts.length === 4 && method === 'POST') {
        const body = await readJson(req);
        return send(req, res, 200, await runtime.reviewReplies.post(parts[2]!, String(body.cardId ?? ''), { ...(body.verdict !== undefined ? { verdict: body.verdict } : {}), ...(body.summary !== undefined ? { summary: body.summary } : {}), ...(body.findings !== undefined ? { findings: body.findings } : {}), ...(body.withoutComment !== undefined ? { withoutComment: body.withoutComment } : {}) }));
      }
      // One finding of a review card: answer its question, ask for it to be fixed, dismiss it or take it back (finding-actions.ts).
      if (runtime && parts[3] === 'findings' && parts.length === 4 && method === 'POST') {
        const body = await readJson(req);
        if (!isFindingAction(body.action)) throw new BadRequest(`action must be one of: ${FINDING_ACTIONS.join(', ')}`);
        return send(req, res, 200, { finding: await runtime.findingActions.act(parts[2]!, String(body.cardId ?? ''), String(body.findingId ?? ''), body.action, typeof body.text === 'string' ? body.text : '') });
      }
      // The card that stays when a review of this session's work ended with findings open: ask for fixes, carry on, or undo that (review-end.ts).
      if (runtime && parts[3] === 'review-end' && parts.length === 4 && method === 'POST') {
        const body = await readJson(req);
        if (!isReviewEndAction(body.action)) throw new BadRequest(`action must be one of: ${REVIEW_END_ACTIONS.join(', ')}`);
        const ids = Array.isArray(body.findingIds) ? body.findingIds.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
        return send(req, res, 200, { reviewEnd: await runtime.reviewEnds.act(parts[2]!, String(body.cardId ?? ''), body.action, ids) });
      }
      // A sidebar from one point of the conversation: the one there is with that key, or a new one (asides.ts).
      if (runtime && parts[3] === 'asides' && parts.length === 4 && method === 'POST') {
        const body = await readJson(req);
        const subject = checkSubject(body.subject);
        if ('problem' in subject) throw new BadRequest(subject.problem);
        return send(req, res, 200, { session: await runtime.asides.open(parts[2]!, { at: str(body.at, 'at', 200), ...(body.key !== undefined ? { key: str(body.key, 'key', ASIDE_KEY_MAX) } : {}), subject: subject.subject }) });
      }
      // Compact the conversation (the context popup's button; a phone's `session.compact` calls the same).
      if (runtime && method === 'POST' && parts.length === 4 && parts[3] === 'compact') {
        await runtime.compact(parts[2]!);
        return send(req, res, 200, { compacting: true });
      }
      if (runtime && method === 'POST' && parts.length === 4 && ['reply', 'answer', 'stop'].includes(parts[3]!)) {
        const body = await readJson(req);
        const id = parts[2]!;
        if (parts[3] === 'reply') {
          if (body.permission !== undefined && !isPermissionLevel(body.permission)) throw new BadRequest('permission must be auto, ask, edits, plan, readonly or bypass');
          const model = typeof body.model === 'string' ? body.model.slice(0, 80) : undefined;
          // 200 with how it went: a message written while the agent works is queued, not refused.
          const draft = draftRefs(body);
          const outcome = await runtime.reply(id, messageText(body.text, 'text', draft !== null), { model, permission: body.permission as never, ...speed(body) }, { draft });
          return send(req, res, 200, { outcome });
        }
        else if (parts[3] === 'stop') await runtime.stop(id);
        else await runtime.answer(id, str(body.requestId, 'requestId', 200), { optionId: typeof body.optionId === 'string' ? body.optionId : undefined, text: typeof body.text === 'string' ? body.text : undefined, answers: answersOf(body.answers), ...(body.confirmed === true ? { confirmed: true } : {}) });
        return send(req, res, 204);
      }
      if (runtime && method === 'POST' && parts.length === 4 && parts[3] === 'draft-summary') {
        const body = await readJson(req);
        const project = (await workspace.state()).projects.find((p) => p.id === body.projectId);
        if (!project) throw new BadRequest('projectId must be a registered project');
        return send(req, res, 200, { summary: await runtime.delegation.draftSummary(parts[2]!, project.name) });
      }
      if (runtime && method === 'POST' && parts.length === 4 && parts[3] === 'move-to-project') {
        const body = await readJson(req);
        return send(req, res, 201, await runtime.delegation.manualMove(parts[2]!, str(body.projectId, 'projectId', 100), str(body.summary, 'summary', 20_000), body.groupId === undefined ? undefined : optionalId(body.groupId, 'groupId')));
      }
      if (method === 'POST' && parts.length === 4 && parts[3] === 'move') {
        const body = await readJson(req);
        const moved = await workspace.moveSession(parts[2]!, optionalId(body.groupId, 'groupId'));
        return send(req, res, 200, { moved });
      }
    }

    // The Files view of any scope (shared/scope.ts): a session, a project page, a group page.
    if (runtime && parts[1] === 'scopes' && method === 'GET' && parts.length === 4 && (parts[3] === 'files' || parts[3] === 'file')) return files(req, res, runtime, decodedSegment(parts[2]!), parts[3], url);
    // A project another computer lists: the folder of this computer that is already that repository, if any,
    // so its page offers to add it (account-project-here.ts).
    if (method === 'GET' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'here') {
      const away = await awayProject(decodedSegment(parts[2]!));
      const beside = (await workspace.state()).projects.flatMap((p) => p.folders.map((f) => f.path));
      return send(req, res, 200, { folder: away ? await folderHere(away, beside) : null });
    }
    // What of the user's Claude Code setup a project's sessions get, and the MCP servers on offer.
    if (parts[1] === 'projects' && parts.length === 4 && parts[3] === 'setup') {
      const project = (await workspace.state()).projects.find((p) => p.id === parts[2]);
      if (!project) return send(req, res, 404, { error: 'No such project' });
      if (method === 'PUT') {
        // `{ inherits: true }` puts the project back on the defaults; anything else is its own setup.
        const body = await readJson(req);
        await workspace.setProjectSetup(project.id, body.inherits === true ? null : body);
      }
      if (method === 'GET' || method === 'PUT') return send(req, res, 200, { ...(await workspace.projectSetup(project.id)), servers: switchableServers(userMcpServers(projectPath(project)).map(publicInfo), (await runtime?.mcpServers?.defs()) ?? []) });
    }
    // The defaults every project starts from.
    if (parts[1] === 'setup' && parts.length === 2) {
      if (method === 'PUT') await workspace.setDefaultSetup(await readJson(req));
      if (method === 'GET' || method === 'PUT') return send(req, res, 200, { setup: await workspace.defaultSetup(), inherits: false, servers: switchableServers(userMcpServers(null).map(publicInfo), (await runtime?.mcpServers?.defs()) ?? []) });
    }
    if (parts[1] === 'projects' && method === 'PATCH' && parts.length === 3) {
      await workspace.renameProject(parts[2]!, str((await readJson(req)).name, 'name', 80));
      return send(req, res, 204);
    }
    // Archive or restore a session, a project or a group.
    if (parts[1] === 'archive' && method === 'POST' && parts.length === 2) {
      const body = await readJson(req);
      if (!isArchiveKind(body.kind)) throw new BadRequest('kind must be session, project or group');
      const id = str(body.id, 'id', 100);
      // A session on another computer of the account is archived or restored there, as one here is (session.archive).
      const away = body.kind === 'session' ? await remoteSession(id) : null;
      if (away) {
        const deps = remoteDeps();
        if (!deps) return send(req, res, 409, { error: remoteRefusal(away.machine.name) });
        const answer = await remoteActionRoute(['api', 'sessions', id, 'archive'], 'POST', async () => ({ archived: body.archived !== false, skipScript: body.skipScript === true }), id, away.machine, deps, url);
        return 'bytes' in answer ? send(req, res, 500, { error: 'The archive could not be done.' }) : send(req, res, answer.status, answer.body);
      }
      const awayP = body.kind === 'project' ? await awayProject(id) : null;
      if (awayP) return send(req, res, 409, { error: notChangedHereRefusal(awayP, here()) });
      // A session's own archive runs its project's archive script first; a failure stops the archive
      // and says why, and the same request with `skipScript` archives without it.
      if (body.kind === 'session') {
        const answer = await sessionPage.route(['api', 'sessions', id, 'archive'], 'POST', url, async () => ({ archived: body.archived !== false, skipScript: body.skipScript === true }));
        return answer && !('bytes' in answer) ? send(req, res, answer.status, answer.body) : send(req, res, 500, { error: 'The archive could not be done.' });
      }
      await workspace.setArchived(body.kind, id, body.archived !== false);
      return send(req, res, 204);
    }
    if (runtime && parts[1] === 'projects' && method === 'DELETE' && parts.length === 3) {
      await workspace.removeProject(parts[2]!);
      terminals.kill(scopeKey({ kind: 'project', id: parts[2]! })); // the project page's shells go with it
      return send(req, res, 204);
    }
    if (parts[1] === 'agents' && method === 'GET') {
      if (parts.length === 4 && parts[3] === 'models' && runtime && isSelectableAgent(parts[2])) return send(req, res, 200, await runtime.models(parts[2] as Agent));
      // What "/" offers in the new-session box, for the agent and project chosen there.
      if (parts.length === 4 && parts[3] === 'slash-commands' && runtime && isSelectableAgent(parts[2])) return send(req, res, 200, { commands: await runtime.draftSlashCommands(parts[2] as Agent, url.searchParams.get('projectId') || null, url.searchParams.get('folderId') || null) });
      return send(req, res, 200, runtime ? await runtime.agentAvailability() : { available: [], notes: {}, signIn: [] });
    }
    if (parts[1] === 'ui-state' && parts.length === 2) {
      if (method === 'GET') {
        const raw = await workspace.getUiState();
        return send(req, res, 200, raw ?? '{}');
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        // Only well-formed tab state is kept; the rest of the blob is the UI's own.
        const tabs = sanitize(body.tabs);
        // What new sessions start with, read back through storedRemembered (shared/sticky-controls.ts).
        const remembered = typeof body.remembered === 'object' && body.remembered !== null ? body.remembered : null;
        // What was looked at is the server's own record now (seen.ts): read it first, so one kept here
        // by an older window is moved out before this write, and never kept here again.
        await workspace.seen.view();
        await workspace.setUiState(JSON.stringify({ tabs, remembered, sidebar: sanitizeSidebar(body.sidebar) }));
        return send(req, res, 204);
      }
    }

    // What the user has looked at: one record, changed here by every window and by a paired phone, pushed to every window.
    if (parts[1] === 'seen' && parts.length === 2) {
      if (method === 'GET') return send(req, res, 200, { seen: await workspace.seen.view() });
      if (method === 'POST') {
        const body = await readJson(req);
        const ids = Array.isArray(body.sessionIds) && body.sessionIds.length <= 500 && body.sessionIds.every((x: unknown) => typeof x === 'string' && x.length < 200) ? (body.sessionIds as string[]) : null;
        if (!ids || (body.unread !== undefined && typeof body.unread !== 'boolean') || (body.unread === true && ids.length !== 1)) return send(req, res, 400, { error: 'Give sessionIds, a list of session ids, and unread: true only with one of them.' });
        const seen = body.unread === true ? await workspace.seen.markUnread(ids[0]!) : await workspace.seen.mark(ids);
        // Another computer's session too: the mark is this computer's, and travels as the account's record (seen-sync.ts).
        return send(req, res, 200, { seen });
      }
    }

    // Workstreams are made by a delegate that spans projects; here they are renamed, described,
    // thinned, stopped and deleted. None of it moves or deletes a session.
    if (parts[1] === 'workstreams' && parts[2]) {
      const id = parts[2];
      // One another computer holds is drawn here and changed only there (issue 83).
      if (method !== 'GET') {
        const view = await workspace.view();
        const elsewhere = [...view.workstreams, ...view.archivedWorkstreams].find((w) => w.id === id);
        const refusal = elsewhere ? remoteWorkstreamRefusal(elsewhere) : null;
        if (refusal) throw new Refused(refusal);
      }
      if (method === 'PATCH' && parts.length === 3) {
        const body = await readJson(req);
        if (body.name !== undefined) await workspace.renameWorkstream(id, str(body.name, 'name', WORKSTREAM_NAME_MAX));
        // Complete is the work's status; archiving is whether it is still in the sidebar. Separate things.
        if (body.status !== undefined) {
          if (body.status !== 'active' && body.status !== 'complete') throw new BadRequest('status must be "active" or "complete"');
          await workspace.setWorkstreamStatus(id, body.status);
        }
        if (body.archived !== undefined) {
          if (typeof body.archived !== 'boolean') throw new BadRequest('archived must be true or false');
          // `sessions: true` on a restore brings its archived sessions back with it.
          await (body.archived ? workspace.archiveWorkstream(id) : workspace.restoreWorkstream(id, { withSessions: body.sessions === true }));
        }
        if (body.objective !== undefined) {
          if (typeof body.objective !== 'string' || body.objective.length > WORKSTREAM_OBJECTIVE_MAX) throw new BadRequest(`objective must be text of at most ${WORKSTREAM_OBJECTIVE_MAX} characters`);
          await workspace.setWorkstreamObjective(id, body.objective);
        }
        return send(req, res, 204);
      }
      if (runtime && method === 'POST' && parts.length === 4 && parts[3] === 'stop') return send(req, res, 200, { stopped: await runtime.delegation.stopWorkstream(id) });
      if (method === 'DELETE' && parts.length === 5 && parts[3] === 'sessions') {
        return send(req, res, 200, await workspace.removeFromWorkstream(id, decodeURIComponent(parts[4]!)));
      }
      // Undo of the above: the session back at the place it had.
      if (method === 'POST' && parts.length === 4 && parts[3] === 'sessions') {
        const body = (await readJson(req)) as { sessionId?: unknown; index?: unknown };
        if (typeof body.sessionId !== 'string' || !body.sessionId) throw new BadRequest('sessionId must be a session id');
        if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) throw new BadRequest('index must be a whole number of at least 0');
        await workspace.addBackToWorkstream(id, body.sessionId, body.index);
        return send(req, res, 204);
      }
      if (method === 'DELETE' && parts.length === 3) {
        await workspace.deleteWorkstream(id);
        return send(req, res, 204);
      }
      return send(req, res, 404, { error: 'Not found' });
    }

    if (parts[1] === 'groups') {
      if (method === 'POST' && parts.length === 2) {
        const body = await readJson(req);
        return send(req, res, 201, await workspace.addGroup(str(body.name, 'name', 80), { projectId: optionalId(body.projectId, 'projectId') }));
      }
      // A Sessions-list group moved into a project (shared/project-groups.ts says when it may).
      if (method === 'POST' && parts.length === 4 && parts[3] === 'project') {
        await workspace.moveGroupToProject(parts[2]!, str((await readJson(req)).projectId, 'projectId', 100));
        return send(req, res, 204);
      }
      if (method === 'PATCH' && parts.length === 3) {
        const body = await readJson(req);
        if (body.name !== undefined) await workspace.renameGroup(parts[2]!, str(body.name, 'name', 80));
        return send(req, res, 204);
      }
      if (runtime && method === 'POST' && parts.length === 4 && parts[3] === 'stop') return send(req, res, 200, { stopped: await runtime.delegation.stopGroup(parts[2]!) });
      if (method === 'DELETE' && parts.length === 3) {
        await workspace.deleteGroup(parts[2]!);
        terminals.kill(scopeKey({ kind: 'group', id: parts[2]! })); // the group page's shells go with it
        return send(req, res, 204);
      }
    }
    return send(req, res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    // A session's Kestrel tools for an out-of-process agent: its own token and checks (kestrel-mcp.ts).
    const mcpSession = runtime ? mcpSessionOf(req.url) : null;
    if (mcpSession && runtime) return void serveSessionMcp(req, res, mcpSession, policy, runtime);
    const access = checkAccess(req, policy);
    if (!access.ok) return send(req, res, access.status, { error: access.reason });
    if (req.method === 'OPTIONS') return send(req, res, 204);
    route(req, res).catch((error: unknown) => {
      if (error instanceof BadRequest) return send(req, res, 400, { error: error.message });
      if (error instanceof Refused) return send(req, res, 409, { error: error.message });
      console.error('[kestrel] request failed', req.method, req.url, error);
      send(req, res, 500, { error: 'Internal error' });
    });
  });

  // The user's own shells, several per session. Only with a runtime (it knows each session's folder).
  const terminals = options.terminals ?? new Terminals();
  // A deleted session's shells go with it, whoever asked for the delete.
  const unsubscribeDeleted = sessionPage.onDeleted((id) => terminals.kill(id));
  const folderOf = async (key: string) => runtime && terminalFolder((await workspace.state()).projects, key, (k) => runtime.folderOf(k));

  /** One directory, or one file, inside a scope's folder (scope-folder.ts). */
  
async function files(req: IncomingMessage, res: ServerResponse, runtime: SessionRuntime, key: string, what: 'files' | 'file', url: URL): Promise<void> {
    const answer = await scopeFiles(runtime, key, what, url);
    return send(req, res, answer.status, 'body' in answer ? answer.body : undefined);
  }

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const access = checkAccess(req, policy);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!access.ok || path !== '/ws') {
      socket.write(`HTTP/1.1 ${access.ok ? 404 : access.status} Refused\r\n\r\n`);
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
  });

  const push = (ws: WebSocket, json: string) => {
    if (ws.readyState === ws.OPEN) ws.send(`{"type":"state","state":${json}}`);
  };
  sockets.on('connection', (ws: WebSocket) => {
    ws.on('error', (error) => console.error('[kestrel] socket error', error));
    const terminal = terminalSocket(ws, terminals, folderOf, runtime && { resolve: (key, actionId) => resolveAction({ state: () => workspace.state(), actions: () => runtime.savedActions.all(), env: () => runtime.projectEnv.all(), folderOf: async (k) => (await folderOf(k)) || null }, key, actionId), preview: options.actionPreview }, async (key) => (runtime ? runtime.folderNote(key) : null));
    // The agent's browser calls, performed by the window that shows the session (browser-bridge.ts).
    const browser = runtime?.browser.bridge.connect((payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload)));
    // The simulator's live picture and the user's touches (sim-socket.ts).
    const sim = runtime && simSocket(runtime.sim.simulator, runtime.sim, {
      sendText: (payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload)),
      sendBinary: (data) => ws.readyState === ws.OPEN && ws.send(data, { binary: true }),
      buffered: () => ws.bufferedAmount,
    });
    ws.on('close', () => {
      live.forget(ws);
      terminal.close();
      browser?.close();
      sim?.close();
    });
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString()) as { type?: string; sessionId?: unknown };
        if (typeof m !== 'object' || m === null) return;
        if (isBrowserMessage(m.type)) return browser?.message(m as Record<string, unknown>);
        if (isSimMessage(m.type)) return sim?.message(m as Record<string, unknown>);
        if (typeof m.sessionId !== 'string' || m.sessionId.length > 120) return;
        if (m.type?.startsWith('term-')) return void terminal.message(m as TerminalMessage);
        if (m.type === 'unwatch') return live.unwatch(ws, m.sessionId);
        if (m.type !== 'watch') return;
        live.watch(ws, m.sessionId);
        const id = m.sessionId;
        void runtime?.snapshot(id).then((snapshot) => snapshot && live.sendTo(ws, id, snapshot));
      } catch {
        // Not a message this server understands; ignore it.
      }
    });
    currentStateJson().then((json) => push(ws, json), (error) => console.error('[kestrel] could not send state', error));
    // Every session's pull requests the server already holds; changes follow as they come.
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pull-requests', all: { ...Object.fromEntries(remoteRequests), ...detailsConfig.sources.store.all() } }));
    if (options.reviewRequests && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'review-requests', view: options.reviewRequests.view() }));
    if (options.tickets && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tickets', view: options.tickets.store.view() }));
    if (options.connect && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'connect-state', view: options.connect.view() }));
    if (options.connect?.steps && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'setup-runs', runs: options.connect.steps.runs() }));
    if (options.connect?.values && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'setup-value-requests', requests: options.connect.values.view() }));
    workspace.seen.view().then((seen) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'seen', seen })), (error) => console.error('[kestrel] could not send what was seen', error));
    workspace.accountOffers.view().then((offers) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'machine-offers', offers })), (error) => console.error('[kestrel] could not send what the other computers offer', error));
    options.whatsNew?.store.view().then((view) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'whats-new', view })), (error) => console.error('[kestrel] could not send what is new', error));
    if (runtime && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'plan-usage', usage: runtime.planUsage.view() }));
  });

  // Each agent account's plan usage, whole, whenever what a window draws changed (plan-usage.ts): never per token.
  const unsubscribePlanUsage = runtime?.planUsage.onChange((usage) => {
    const json = JSON.stringify({ type: 'plan-usage', usage });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // What's new, whole, whenever it changes: notes shown, or the switch.
  const unsubscribeWhatsNew = options.whatsNew?.store.onChange((view) => {
    const json = JSON.stringify({ type: 'whats-new', view });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // What was looked at, whole, whenever it changes: from this window, another, or a phone.
  const unsubscribeSeen = workspace.seen.onChange((seen) => {
    const json = JSON.stringify({ type: 'seen', seen });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // What the account's other computers offer for a new session, whole, whenever a reading of their records changed it.
  const unsubscribeOffers = workspace.accountOffers.onChange((offers) => {
    const json = JSON.stringify({ type: 'machine-offers', offers });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // Another computer's pull requests, as it sent them (RemoteSessions.readPullRequests), held once and pushed to every
  // window as this computer's own are, so a session there shows its request as a session here does.
  const remoteRequests = new Map<string, unknown>();
  const unsubscribeRemoteRequests = options.connect?.remote.onPullRequests((_machine, lookups) => {
    const changes: Record<string, unknown> = {};
    for (const [id, lookup] of Object.entries(lookups)) {
      if (JSON.stringify(remoteRequests.get(id)) === JSON.stringify(lookup)) continue;
      remoteRequests.set(id, lookup);
      changes[id] = lookup;
    }
    if (Object.keys(changes).length === 0) return;
    const json = JSON.stringify({ type: 'pull-requests', changes });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // The PR store's changes, gathered for a moment and sent to every window together.
  let prChanges: Record<string, unknown> | null = null;
  const unsubscribePullRequests = detailsConfig.sources.store.onChange((sessionId, value) => {
    if (sockets.clients.size === 0) return;
    if (!prChanges) {
      prChanges = {};
      setTimeout(() => {
        const json = JSON.stringify({ type: 'pull-requests', changes: prChanges });
        prChanges = null;
        for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
      }, BROADCAST_COALESCE_MS);
    }
    prChanges[sessionId] = value;
  });

  // The review requests, whole, whenever they change: the list is short.
  const unsubscribeReviewRequests = options.reviewRequests?.onChange((view) => {
    const json = JSON.stringify({ type: 'review-requests', view });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // The tickets, whole, whenever they change: the list is short.
  const unsubscribeTickets = options.tickets?.store.onChange((view) => {
    const json = JSON.stringify({ type: 'tickets', view });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // Set up this computer's runs, whole, whenever one changes: a few lines at most.
  const unsubscribeSetupRuns = options.connect?.steps?.onChange((runs) => {
    const json = JSON.stringify({ type: 'setup-runs', runs });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // Other computers' requests for set-up values, waiting on the person here: names only, whole, whenever one comes or goes.
  const unsubscribeValueRequests = options.connect?.values?.onChange((requests) => {
    const json = JSON.stringify({ type: 'setup-value-requests', requests });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  const unsubscribeConnect = options.connect?.onChange((view) => {
    const json = JSON.stringify({ type: 'connect-state', view });
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  });

  // A simulator tool ran for a session, or a device changed: every window hears it and the ones that care act.
  const everyone = (payload: object) => {
    const json = JSON.stringify(payload);
    for (const ws of sockets.clients) if (ws.readyState === ws.OPEN) ws.send(json);
  };
  // A session that gives way to another is deleted next: every window hears which one took its place
  // at once and before the workspace without it, whether or not it was watching (the live channel
  // holds a patch for LIVE_FLUSH_MS and sends it to watchers only), so its tab follows instead of closing.
  const unsubscribeReplaced = runtime?.onLive((sessionId, patch) => {
    if (patch.replacedBy) everyone({ type: 'live', sessionId, patch: { replacedBy: patch.replacedBy } });
  });
  const unsubscribeSimShow = runtime?.onSimShow((sessionId, udid) => everyone({ type: 'sim-show', sessionId, udid }));
  const unsubscribeSimChange = runtime?.sim.simulator.onChange((udid) => everyone({ type: 'sim-changed', udid }));

  let pending: NodeJS.Timeout | null = null;
  const unsubscribe = workspace.onChange(() => {
    stateJson = null;
    if (watchedElsewhere.size > 0) void rewatchElsewhere().catch((error: unknown) => console.error('[kestrel] could not watch a session on another computer', error));
    if (pending || sockets.clients.size === 0) return;
    pending = setTimeout(() => {
      pending = null;
      currentStateJson().then(
        (json) => {
          for (const ws of sockets.clients) push(ws, json);
        },
        (error) => console.error('[kestrel] could not broadcast state', error),
      );
    }, BROADCAST_COALESCE_MS);
  });

  return {
    server,
    watched: () => sockets.clients.size > 0,
    watching: (sessionId) => live.isWatched(sessionId),
    port: () => policy.port,
    listen: () =>
      new Promise((resolve) =>
        server.listen(policy.port, LOOPBACK_HOST, () => {
          // The browser pane never opens Kestrel's own API (the port really bound) or its interface.
          const bound = server.address();
          if (typeof bound === 'object' && bound) policy.port = bound.port;
          runtime?.browser.protect({ serverPort: policy.port, appOrigins: policy.allowedOrigins });
          resolve();
        }),
      ),
    close: () =>
      new Promise((resolve) => {
        unsubscribe();
        unsubscribePullRequests();
        unsubscribeDeleted();
        unsubscribeRemoteRequests?.();
        unsubscribeSeen();
        unsubscribeOffers();
        unsubscribeWhatsNew?.();
        unsubscribePlanUsage?.();
        unsubscribeReviewRequests?.();
        unsubscribeTickets?.();
        unsubscribeConnect?.();
        unsubscribeSetupRuns?.();
        unsubscribeValueRequests?.();
        unsubscribeLive?.();
        unsubscribeRemote?.();
        unsubscribeSimShow?.();
        unsubscribeReplaced?.();
        unsubscribeSimChange?.();
        runtime?.sim.simulator.close();
        live.close();
        terminals.closeAll();
        if (pending) clearTimeout(pending);
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        server.close(() => resolve());
        // close() alone waits for every connection to end by itself, and one that never does (a
        // request still being answered, a client that went quiet) kept the server up until the
        // shell gave up and killed it: an eight-second quit. Nothing is worth waiting for here.
        server.closeAllConnections();
      }),
  };
}
