// Client state. One store (Zustand), read through selectors so a component re-renders only when the
// slice it uses changes. The server is the source of truth: it pushes the whole derived
// workspace on change, and unchanged objects keep their identity here (structural sharing),
// so memoized rows do not re-render when something unrelated moves.
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { CommandOutput } from '@kestrel/server/commands';
import type { Agent, ChatMessage, Group, LivePatch, PinKind, Project, SessionDetail, SessionQueue, SessionSettings, SessionView, WorkspaceState } from '@kestrel/server/model';
import type { PermissionLevel } from '@kestrel/server/permissions';
import type { BaseChoice } from '@kestrel/server/start-base';
import { pinKey, placePin, type PinRef } from '@kestrel/server/pins';
import { normalizeProject } from '@kestrel/server/project-folders';
import { isPullRequestLookup, type PullRequestLookup } from '@kestrel/server/details';
import { asSourced, type Sourced } from '@kestrel/server/sourced';
import { asReviewRequestsView, NO_REVIEW_REQUESTS, type ReviewRequestsView } from '@kestrel/server/review-requests';
import { initialTabs } from '@kestrel/server/tabs';
import { DEFAULT_REMEMBERED } from '@kestrel/server/sticky-controls';
import { EMPTY_SIDEBAR } from '@kestrel/server/sidebar';
import type { TabsView } from './tabsStore.ts';
import type { SimulatorState } from './simulatorStore.ts';
/** The reason given when the server predates a route. */
export const RESTART_REASON = 'restart Kestrel to load this';

declare global {
  interface Window {
    __KESTREL__?: { port: number; token: string } | null;
    /** Set by the Electron preload script; absent in a plain browser. */
    kestrelShell?: {
      launch: { port: number; token: string };
      /** The operating system, e.g. `darwin`. */
      platform?: string;
      pickFolder(): Promise<string | null>;
      /** Where a dropped or chosen file is on disk (Electron's webUtils). Absent in older shells. */
      pathForFile?(file: File): string;
      reveal(path: string): Promise<void>;
      onCommand(listener: (command: string) => void): () => void;
      /** The keys the app menu gives Kestrel's commands, by command id, as menu accelerators ('' for none). Absent in older shells. */
      setShortcuts?(accelerators: Record<string, string>): void;
      /** Show a system notification; the system's refusal comes back as a reason. Absent in older shells. */
      notify?(notification: { title: string; body: string; sessionId: string }): Promise<{ ok: boolean; reason?: string }>;
      /** A system notification was clicked: the session it was for. Absent in older shells. */
      onNotificationClick?(listener: (sessionId: string) => void): () => void;
      /** Folders opened with Kestrel (dropped on its Dock icon), including any from before the page asked. Absent in older shells. */
      onOpenFolders?(listener: (paths: string[]) => void): () => void;
      /** A PNG (base64) of the visible page in a browser-pane webview, by its webContents id. */
      captureBrowser?(webContentsId: number): Promise<{ mediaType: string; data: string; width: number; height: number } | null>;
      /** A part of a browser-pane page that failed to load (a 404 script, a refused request). */
      onBrowserLoadFailed?(listener: (failure: { webContentsId: number; url: string; text: string }) => void): () => void;
      /** Whether the window is full screen (the Mac hides its traffic lights then), now and on every change. */
      onFullScreen?(listener: (fullScreen: boolean) => void): () => void;
      /** The app's name and version. Absent in older shells. */
      app?: { name: string; version: string; packaged: boolean };
      /** The updater (packaged app only does anything): its state now, its changes, and restarting into a downloaded update. */
      updateState?(): Promise<UpdateState | null>;
      onUpdate?(listener: (state: UpdateState) => void): () => void;
      restartToUpdate?(): Promise<boolean>;
    };
  }
}

/** The Electron shell's updater (app/updater.mjs). */
export type UpdateState = { status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number };

/** The files a message carries: the composer's draft, and the uploaded ids in order (components/attachments/draftStore.ts). */
export type AttachmentRefs = { draftId: string; attachments: string[] };

/** An answer to a card: an option, typed text, or each question's chosen label(s). */
export type CardAnswer = { optionId?: string; text?: string; answers?: Record<string, string> };

export type Connection = 'connecting' | 'live' | 'offline' | 'no-server';

/** Streaming state of one session, built from the live channel. Separate from the workspace. */
/** What is held for a watched session: every field of a patch, except the one-off removals already applied. */
export type LiveState = Required<Omit<LivePatch, 'removedMessages'>>;

export interface AppState {
  connection: Connection;
  live: ReadonlyMap<string, LiveState>;
  /** Folder whose name is being edited in its sidebar row. */
  renaming: string | null;
  /** Session whose tag box is open in its top line. */
  tagging: string | null;
  /**
   * The session that was opened from a reference row (under a workstream or a tag), while it is the
   * open one: that row is the highlighted one, and its home row only marks that it is open. Null
   * when the open session was reached any other way.
   */
  openedFromReference: string | null;
  workspace: WorkspaceState | null;
  sessionsById: ReadonlyMap<string, SessionView>;
  details: ReadonlyMap<string, SessionDetail>;
  /** Every session's pull requests, as the server's PR store pushes them (server/src/pull-requests/store.ts). */
  pullRequests: ReadonlyMap<string, Sourced<PullRequestLookup>>;
  /** Moves on every change to `pullRequests`: what is built from all of them (the Pull requests page) is asked for again then. */
  pullRequestsVersion: number;
  /** The requests the user was asked to review, as the server pushes them (server/src/review-requests/store.ts). */
  reviewRequests: ReviewRequestsView;
  /** Other server data, one entry per route path (data/resources.ts). */
  resources: ReadonlyMap<string, Sourced<unknown>>;
  /** Open tabs, the composer's last choices, the sidebar's layout and what was seen, kept on the server (tabsStore.ts owns the writes). */
  tabs: TabsView;
  /** The simulators, each one's screen and state, each session's chosen device and each device's latest problem (simulatorStore.ts owns the writes). */
  simulator: SimulatorState;
  error: string | null;
}

type Launch = { port: number; token: string };
let launch: Launch | null = window.kestrelShell?.launch ?? window.__KESTREL__ ?? null;
/** The port Kestrel's server listens on, so the browser pane can refuse to open it. */
export const serverPort = (): number | undefined => launch?.port;

/**
 * The server makes a new token every time it starts. When a request is refused or the socket
 * drops, ask the shell (the Vite dev server today, Electron later) for the current one.
 */
async function refreshLaunch(): Promise<boolean> {
  // The Electron shell hands over the token once; there is no dev-server file to ask.
  if (window.kestrelShell) return false;
  try {
    const res = await fetch('/__kestrel/launch', { cache: 'no-store' });
    const next = res.ok ? ((await res.json()) as Launch | null) : null;
    if (!next) return false;
    const changed = next.token !== launch?.token || next.port !== launch?.port;
    launch = next;
    return changed;
  } catch {
    return false;
  }
}

const initialState: AppState = { connection: launch ? 'connecting' : 'no-server', live: new Map(), renaming: null, tagging: null, openedFromReference: null, workspace: null, sessionsById: new Map(), details: new Map(), pullRequests: new Map(), reviewRequests: NO_REVIEW_REQUESTS, pullRequestsVersion: 0, resources: new Map(), tabs: { loaded: false, state: initialTabs(), remembered: DEFAULT_REMEMBERED, sidebar: EMPTY_SIDEBAR, seen: null }, simulator: { devices: { loaded: false, devices: [], unavailable: null }, infos: new Map(), chosen: new Map(), errors: new Map() }, error: null };

/** The one store (Zustand). Everything the app knows about the server lives here, once. */
const appStoreApi = createStore<AppState>()(() => initialState);
/** The store as it is now. */
const current = (): AppState => appStoreApi.getState();

function set(patch: Partial<AppState>) {
  appStoreApi.setState(patch);
}

/** For the modules that own a slice's writes: the tabs (tabsStore.ts) and the simulator (simulatorStore.ts). */
export function setApp(patch: Pick<Partial<AppState>, 'tabs' | 'simulator'>) {
  set(patch);
}

/** For other stores (tabs) that follow this one. */
/** Sessions to open scrolled to their pending card (set by the Needs you queue). */
export const focusRequests = new Set<string>();

export const appStore = { subscribe: (listener: () => void) => appStoreApi.subscribe(() => listener()), get: current };

/** Select a slice of the store. The selector must return a stable reference for unchanged data. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStoreApi, selector);
}

// ---- structural sharing ---------------------------------------------------------

function sameShallow(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if ((a as any)[k] !== (b as any)[k]) return false;
  return true;
}

const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function sameSession(a: SessionView, b: SessionView): boolean {
  const { filing: fa, tags: ta, ...ra } = a;
  const { filing: fb, tags: tb, ...rb } = b;
  return sameShallow(ra, rb) && sameShallow(fa, fb) && sameStrings(ta, tb);
}

/** Keep the previous array (and items) wherever the incoming data is identical. */
function shareList<T extends { id: string }>(prev: readonly T[] | undefined, next: T[], same: (a: T, b: T) => boolean): T[] {
  if (!prev) return next;
  const byId = new Map(prev.map((p) => [p.id, p]));
  let identical = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = byId.get(item.id);
    const kept = old && same(old, item) ? old : item;
    if (kept !== prev[i]) identical = false;
    return kept;
  });
  return identical ? (prev as T[]) : out;
}

function shareJson<T>(prev: T | undefined, next: T): T {
  return prev !== undefined && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/** Same name and the same directories in the same order. */
const sameProject = (a: Project, b: Project) => a.name === b.name && (a.defaultFolderId ?? null) === (b.defaultFolderId ?? null) && JSON.stringify(a.folders) === JSON.stringify(b.folders);

function applyWorkspace(next: WorkspaceState) {
  const prev = current().workspace;
  const sessions = shareList(prev?.sessions, next.sessions, sameSession);
  // A server from before project directories sends `path` and `isGit`: each becomes one directory here, once.
  const archived = next.archived ?? { sessions: [], projects: [], groups: [] };
  const workspace: WorkspaceState = {
    projects: shareList(prev?.projects, next.projects.map(normalizeProject), sameProject),
    groups: shareList(prev?.groups, next.groups, sameShallow),
    sessions,
    links: shareList(prev?.links, next.links, sameShallow),
    trees: Object.fromEntries(Object.entries(next.trees).map(([key, tree]) => [key, shareJson(prev?.trees[key], tree)])),
    archived: shareJson(prev?.archived, { ...archived, projects: archived.projects.map(normalizeProject) }),
    pins: shareJson(prev?.pins, next.pins ?? []),
    // A server from before workstreams sends none.
    workstreams: shareJson(prev?.workstreams, next.workstreams ?? []),
    // A server from before archiving sends none.
    archivedWorkstreams: shareJson(prev?.archivedWorkstreams, next.archivedWorkstreams ?? []),
    // A server from before waits between sessions sends none.
    waits: shareJson(prev?.waits, next.waits ?? []),
  };
  const sessionsById = sessions === prev?.sessions ? current().sessionsById : new Map(sessions.map((s) => [s.id, s]));
  // A cached detail is stale once its session changed; drop it so the next read refetches.
  let details = current().details;
  for (const [id, detail] of current().details) {
    if (sessionsById.get(id) !== detail.session) {
      if (details === current().details) details = new Map(current().details);
      (details as Map<string, SessionDetail>).delete(id);
    }
  }
  set({ workspace, sessionsById, details, connection: 'live', error: null });
}

/**
 * The server's PR store, pushed: `all` on connecting (replaces what was held), `changes` after
 * (a session's new answer, or null when it is gone). An answer identical to the one held keeps its
 * identity, so nothing that shows it re-renders.
 */
export function applyPullRequests(message: { all?: unknown; changes?: unknown }) {
  const prev = current().pullRequests;
  const incoming = (message.all ?? message.changes) as Record<string, unknown> | undefined;
  if (!incoming || typeof incoming !== 'object') return;
  const next = new Map(message.all ? [] : prev);
  let changed = message.all !== undefined && Object.keys(incoming).length !== prev.size;
  for (const [id, raw] of Object.entries(incoming)) {
    if (raw === null) {
      changed = next.delete(id) || changed;
      continue;
    }
    const value = asSourced(raw, isPullRequestLookup, RESTART_REASON);
    const kept = shareJson(prev.get(id), value);
    if (kept !== prev.get(id)) changed = true;
    next.set(id, kept);
  }
  if (changed) set({ pullRequests: next, pullRequestsVersion: current().pullRequestsVersion + 1 });
}

/**
 * The server's review requests, pushed whole. A request that did not change keeps its identity, and
 * so does the list when nothing in it did, so the rows that show them do not re-render.
 */
export function applyReviewRequests(raw: unknown) {
  const prev = current().reviewRequests;
  const view = asReviewRequestsView(raw);
  const byKey = new Map(prev.requests.map((r) => [r.key, r]));
  const requests = view.requests.map((r) => shareJson(byKey.get(r.key), r));
  const same = requests.length === prev.requests.length && requests.every((r, i) => r === prev.requests[i]);
  const next: ReviewRequestsView = { requests: same ? prev.requests : requests, problems: shareJson(prev.problems, view.problems), order: shareJson(prev.order, view.order) };
  if (next.requests !== prev.requests || next.problems !== prev.problems || next.order !== prev.order) set({ reviewRequests: next });
}

/** Write one route's answer into `resources`; an answer identical to the one held keeps its identity. At most MAX_RESOURCES are kept, the least recently written dropped first. */
export function putResource(path: string, value: Sourced<unknown>) {
  const prev = current().resources;
  const kept = shareJson(prev.get(path), value);
  if (kept === prev.get(path)) return;
  const next = new Map(prev);
  next.delete(path);
  next.set(path, kept);
  while (next.size > MAX_RESOURCES) next.delete(next.keys().next().value!);
  set({ resources: next });
}
const MAX_RESOURCES = 300;

// ---- transport ------------------------------------------------------------------

export async function call<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  if (!launch) throw new Error('Kestrel server is not running');
  const res = await fetch(`http://127.0.0.1:${launch.port}${path}`, { ...init, headers: { Authorization: `Bearer ${launch.token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (res.status === 401 && !retried && (await refreshLaunch())) return call<T>(path, init, true);
  if (res.status === 204) return undefined as T;
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${res.status})`), { status: res.status, field: typeof body?.field === 'string' ? body.field : undefined, archiveScript: body?.archiveScript as { output: string } | undefined });
  return body as T;
}

/** Bytes from the server (a picture), sent with the token in a header, never in the URL. */
export async function fetchBlob(path: string, retried = false): Promise<Blob> {
  if (!launch) throw new Error('Kestrel server is not running');
  const res = await fetch(`http://127.0.0.1:${launch.port}${path}`, { headers: { Authorization: `Bearer ${launch.token}` } });
  if (res.status === 401 && !retried && (await refreshLaunch())) return fetchBlob(path, true);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.blob();
}

/** Send a file's bytes (an attachment upload); the parsed answer, or an error in words (`messageFor`). */
export async function sendBytes<T>(path: string, body: Blob, headers: Record<string, string>, retried = false): Promise<T> {
  if (!launch) throw new Error('Kestrel server is not running');
  const res = await fetch(`http://127.0.0.1:${launch.port}${path}`, { method: 'POST', body, headers: { Authorization: `Bearer ${launch.token}`, ...headers } });
  if (res.status === 401 && !retried && (await refreshLaunch())) return sendBytes(path, body, headers, true);
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Error(messageFor(Object.assign(new Error(answer?.error ?? `Upload failed (${res.status})`), { status: res.status })));
  return answer as T;
}

/** What the server answers for a route it does not have: it is older than this window. */
const UNKNOWN_ROUTE = 'Not found';
export const OLDER_SERVER = 'This needs a newer Kestrel server than the one running. Quit and reopen Kestrel, then try again.';

/** An action's failure in words. A route the running server does not have says to restart, not "Not found". */
export function messageFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number }).status;
  return status === 404 && message === UNKNOWN_ROUTE ? OLDER_SERVER : message;
}

/** Runs an action and surfaces a refusal in the UI instead of dropping it. */
export async function act<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    set({ error: messageFor(error) });
    return undefined;
  }
}

/** Messages with the same id replace each other; others are appended. Unchanged ones keep identity. */
function mergeMessages(prev: readonly ChatMessage[], changed: readonly ChatMessage[]): ChatMessage[] {
  const next = [...prev];
  for (const m of changed) {
    const i = m.id === undefined ? -1 : next.findIndex((x) => x.id === m.id);
    if (i >= 0) next[i] = m;
    else next.push(m);
  }
  return next;
}

/** Without the messages the server took back out (sent into a turn that ended before the agent read them). */
function withoutRemoved(messages: ChatMessage[], removed: readonly string[] | undefined): ChatMessage[] {
  if (!removed?.length) return messages;
  const gone = new Set(removed);
  return messages.filter((m) => m.id === undefined || !gone.has(m.id));
}

const NO_QUEUE: SessionQueue = { items: [], held: false };

function applyLive(id: string, patch: LivePatch) {
  const prev = current().live.get(id) ?? { messages: [], files: [], filesProblem: null, commands: [], slashCommands: [], agentOutput: '', kestrelTools: 'unknown' as const, kestrelMissing: [] as string[], settings: { model: '', permission: 'ask' as PermissionLevel }, status: '', subagents: [], subagentsAfter: null, queue: NO_QUEUE, context: null, backgroundTasks: [] };
  const next: LiveState = {
    messages: withoutRemoved(patch.messages ? mergeMessages(prev.messages, patch.messages) : prev.messages, patch.removedMessages),
    files: patch.files ?? prev.files,
    filesProblem: patch.filesProblem === undefined ? prev.filesProblem : patch.filesProblem,
    agentOutput: patch.agentOutput ?? prev.agentOutput,
    kestrelTools: patch.kestrelTools ?? prev.kestrelTools,
    kestrelMissing: patch.kestrelMissing ?? prev.kestrelMissing,
    settings: patch.settings ?? prev.settings,
    status: patch.status ?? prev.status,
    subagents: patch.subagents ?? prev.subagents,
    subagentsAfter: patch.subagentsAfter === undefined ? prev.subagentsAfter : patch.subagentsAfter,
    queue: patch.queue ?? prev.queue,
    context: patch.context ?? prev.context,
    backgroundTasks: patch.backgroundTasks ?? prev.backgroundTasks,
    commands: patch.commands ?? prev.commands,
    slashCommands: patch.slashCommands ?? prev.slashCommands,
  };
  set({ live: new Map(current().live).set(id, next) });
}

const watched = new Set<string>();
let socketRef: WebSocket | null = null;

/**
 * The socket as feature stores use it. Each feature owns the messages whose type starts with its
 * prefix (`term-` for `terminalStore.ts`, `browser-` for `browserStore.ts`, `sim-` for `simulatorStore.ts`) and is handed them, so
 * this file does not need to know about terminals or the browser and they do not import each other.
 */
export type SocketMessage = { type: string; sessionId: string } & Record<string, unknown>;
export interface SocketHandler {
  /** A message whose type starts with the feature's prefix. */
  message(message: SocketMessage): void;
  /** A binary message (only the simulator's pictures are binary). */
  binary?(data: ArrayBuffer): void;
  /** The socket (re)connected: say again what the server needs to know. */
  opened(): void;
}
const socketHandlers = new Map<string, SocketHandler>();

function featureSocket(prefix: string) {
  return {
    send(payload: { type: string } & Record<string, unknown>): boolean {
      if (socketRef?.readyState !== WebSocket.OPEN) return false;
      socketRef.send(JSON.stringify(payload));
      return true;
    },
    register(handler: SocketHandler): void {
      socketHandlers.set(prefix, handler);
      if (socketRef?.readyState === WebSocket.OPEN) handler.opened();
    },
  };
}
export const terminalSocket = featureSocket('term-');
export const browserSocket = featureSocket('browser-');
export const simulatorSocket = featureSocket('sim-');
const handlerFor = (type: unknown) => (typeof type === 'string' ? [...socketHandlers].find(([prefix]) => type.startsWith(prefix))?.[1] : undefined);
function sendWatch(type: 'watch' | 'unwatch', sessionId: string) {
  if (socketRef?.readyState === WebSocket.OPEN) socketRef.send(JSON.stringify({ type, sessionId }));
}

let retry = 500;
function connect() {
  if (!launch) return;
  const socket = new WebSocket(`ws://127.0.0.1:${launch.port}/ws?token=${launch.token}`);
  socketRef = socket;
  socket.binaryType = 'arraybuffer';
  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) return socketHandlers.get('sim-')?.binary?.(event.data);
    const message = JSON.parse(event.data);
    if (message.type === 'state') applyWorkspace(message.state);
    else if (message.type === 'live') applyLive(message.sessionId, message.patch);
    else if (message.type === 'pull-requests') applyPullRequests(message);
    else if (message.type === 'review-requests') applyReviewRequests(message.view);
    else handlerFor(message.type)?.message(message);
  };
  socket.onopen = () => {
    retry = 500;
    for (const id of watched) sendWatch('watch', id); // a restarted server sends a fresh snapshot
    for (const handler of socketHandlers.values()) handler.opened();
  };
  socket.onclose = () => {
    set({ connection: 'offline' });
    const delay = retry;
    retry = Math.min(retry * 2, 8000);
    // A dropped socket usually means the server restarted, which also means a new token.
    setTimeout(() => void refreshLaunch().then(connect), delay);
  };
}
if (launch) connect();
else void refreshLaunch().then((found) => found && (set({ connection: 'connecting' }), connect()));

const inFlight = new Map<string, Promise<void>>();
const drafting = new Map<string, Promise<string | null>>();
/** What the controls offer when the server cannot say: the agent's default model, every mode, no context ring. */

export const actions = {
  clearError: () => set({ error: null }),
  /** Say why something the user asked for could not happen, where other failures are said. */
  showError: (message: string) => set({ error: message }),

  /**
   * Fetch a session's detail unless a current copy is cached or already on its way. `again` fetches
   * even over a cached copy, for a change the session row does not show (one of two cards answered).
   */
  loadDetail(id: string, again = false): void {
    if ((current().details.has(id) && !again) || inFlight.has(id)) return;
    const request = call<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`)
      .then((detail) => {
        // Reuse the store's session object so the cache check in applyWorkspace is by identity.
        const session = current().sessionsById.get(id) ?? detail.session;
        set({ details: new Map(current().details).set(id, { ...detail, session }) });
      })
      .catch((error) => set({ error: error instanceof Error ? error.message : String(error) }))
      .finally(() => inFlight.delete(id));
    inFlight.set(id, request);
  },

  /** Start receiving a session's streaming output; the server answers with a snapshot. */
  watch(id: string): () => void {
    watched.add(id);
    sendWatch('watch', id);
    return () => {
      watched.delete(id);
      sendWatch('unwatch', id);
    };
  },

  /** The project at a path: the existing one if it is registered, a new one otherwise. */
  ensureProject: (path: string) => act(() => call<{ project: Project; created: boolean }>('/api/projects/ensure', { method: 'POST', body: JSON.stringify({ path }) })),
  registerProject: (path: string, name?: string) => act(() => call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ path, name }) })),
  /** Send a message; while the agent works it goes into the running turn (or is held, shared/mid-turn.ts). True when it was accepted either way. */
  reply: async (id: string, text: string, change: Partial<SessionSettings> = {}, files: AttachmentRefs | null = null) => (await act(async () => (await call(`/api/sessions/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify({ text, ...change, ...files }) }), true))) === true,
  /** Send what is held now (after a stop, a failure or a restart). */
  sendQueued: (id: string) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/queue/send`, { method: 'POST', body: '{}' })),
  /** Drop one held message. True when it was still held and is gone now. */
  removeQueued: async (id: string, messageId: string) => (await act(async () => (await call(`/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`, { method: 'DELETE' }), true))) === true,
  /** Answer a card: an option, typed text, or (for question cards) each question's chosen label(s). */
  answer: (id: string, requestId: string, answer: CardAnswer) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ requestId, ...answer }) })),
  /** The same, for a caller that shows the refusal itself (a Needs you row): the reason, or null when it went through. */
  answerHere: (id: string, requestId: string, answer: CardAnswer): Promise<string | null> =>
    call(`/api/sessions/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ requestId, ...answer }) }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
  stop: (id: string) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' })),
  /** Stop one piece of background work; the row shows the refusal itself: the reason, or null when it was asked. */
  stopBackgroundTask: (id: string, taskId: string): Promise<string | null> =>
    call(`/api/sessions/${encodeURIComponent(id)}/background-tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST', body: '{}' }).then(
      () => null,
      (error: unknown) => messageFor(error),
    ),

  /** What one command printed (the Commands pane). */
  commandOutput: (id: string, commandId: string): Promise<CommandOutput> => call<CommandOutput>(`/api/sessions/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/output`),
  /** "Retry command": the session's agent is told which command to run again; a refusal shows in the error line. */
  retryCommand: (id: string, commandId: string) => act(() => call<{ outcome: 'sent' | 'delivered' | 'queued' }>(`/api/sessions/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/retry`, { method: 'POST', body: '{}' })),
  /** Stop one command; the reason it was refused, or null when it was asked. */
  stopCommand: (id: string, commandId: string): Promise<string | null> =>
    call(`/api/sessions/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/stop`, { method: 'POST', body: '{}' }).then(
      () => null,
      (error: unknown) => messageFor(error),
    ),

  /** Open the folder a pane shows (a session's worktree, a project's folder) in an app on this Mac; a refusal shows in the error line. */
  openFolder: (scope: string, app: string) => act(() => call('/api/open-folder', { method: 'POST', body: JSON.stringify({ scope, app }) })),
  /** "Stop command" from a command's menu: a refusal shows in the error line. */
  stopCommandFromMenu: (id: string, commandId: string) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/stop`, { method: 'POST', body: '{}' })),

  moveSession: (id: string, groupId: string | null) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ groupId }) })),
  createGroup: (name: string, projectId?: string) => act(() => call<{ id: string }>('/api/groups', { method: 'POST', body: JSON.stringify({ name, ...(projectId ? { projectId } : {}) }) })),
  /** A Sessions-list group, with its sessions, into a project; refused with the reason when something in it belongs elsewhere. */
  moveGroupToProject: async (groupId: string, projectId: string): Promise<boolean> => (await act(() => call(`/api/groups/${encodeURIComponent(groupId)}/project`, { method: 'POST', body: JSON.stringify({ projectId }) }).then(() => true))) ?? false,
  renameGroup: (id: string, name: string) => act(() => call(`/api/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })),
  deleteGroup: (id: string) => act(() => call(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  createSession: (input: { prompt: string; agent: Agent; projectId: string | null; groupId: string | null; folderId?: string | null; model?: string; effort?: string; fast?: boolean; modelChosen?: boolean; permission?: PermissionLevel; base?: BaseChoice; rememberBase?: boolean } & Partial<AttachmentRefs>) => act(() => call<{ id: string }>('/api/sessions', { method: 'POST', body: JSON.stringify(input) })),
  /** Start reviewing a request the user was asked to review, or get the review already started (server review-requests/start.ts). */
  startReview: (key: string) => act(() => call<{ id: string }>('/api/review-requests/start', { method: 'POST', body: JSON.stringify({ key }) })),
  stopFolder: (id: string) => act(() => call<{ stopped: number }>(`/api/groups/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' })),
  /** Ask the agent for the summary of a manual move; null when it cannot be asked. */
  draftSummary(sessionId: string, projectId: string): Promise<string | null> {
    // One ask at a time per move: a re-render (or React's dev double-mount) must not ask the agent twice.
    const key = `${sessionId}:${projectId}`;
    let ask = drafting.get(key);
    if (!ask) {
      ask = act(() => call<{ summary: string | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/draft-summary`, { method: 'POST', body: JSON.stringify({ projectId }) }))
        .then((r) => r?.summary ?? null)
        .finally(() => drafting.delete(key));
      drafting.set(key, ask);
    }
    return ask;
  },
  /** Fork a session: a new one carrying on from a copy of its conversation (server/src/fork.ts). The new session, or undefined with the reason shown. */
  /** `turn`: the message that started the turn to fork from; absent, the end of the conversation. */
  forkSession: (sessionId: string, turn?: string) => act(() => call<{ id: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: 'POST', body: JSON.stringify(turn ? { turn } : {}) })),
  moveToProject: (sessionId: string, projectId: string, summary: string, groupId?: string) => act(() => call<{ id: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/move-to-project`, { method: 'POST', body: JSON.stringify({ projectId, summary, ...(groupId ? { groupId } : {}) }) })),
  removeProject: (id: string) => act(() => call(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  startRename: (id: string | null) => set({ renaming: id }),
  /** A session row was used to open its session: remember whether it was a reference row (under a workstream or tag). */
  openedFrom: (sessionId: string, reference: boolean) => set({ openedFromReference: reference ? sessionId : null }),
  /** Pin to, or unpin from, the top of the sidebar. */
  /** The CODE REVIEWS rows in a new order (request keys). Shown at once; the server's push confirms it. */
  orderReviews: (order: string[]) => {
    const held = current().reviewRequests;
    set({ reviewRequests: { ...held, order } });
    return act(() => call('/api/review-requests/order', { method: 'PUT', body: JSON.stringify({ order }) }));
  },
  setPinned: (kind: PinKind, id: string, pinned: boolean) => act(() => call('/api/pins', { method: 'POST', body: JSON.stringify({ kind, id, pinned }) })),
  /**
   * A row dropped on the PINNED section, beside `target` (or at the end). One already pinned moves;
   * one that is not is pinned there. Shown at once; the server's next state confirms or puts it back.
   */
  placePin: async (moving: PinRef, target: PinRef | null, after: boolean) => {
    const ws = current().workspace;
    if (!ws) return;
    const existing = ws.pins.find((p) => pinKey(p) === pinKey(moving));
    const next = placePin(ws.pins, existing ?? { kind: moving.kind, id: moving.id, pinnedAt: Date.now() }, target, after);
    set({ workspace: { ...ws, pins: next } });
    const saved = await act(async () => {
      if (!existing) await call('/api/pins', { method: 'POST', body: JSON.stringify({ kind: moving.kind, id: moving.id, pinned: true }) });
      await call('/api/pins/order', { method: 'POST', body: JSON.stringify({ pins: next.map(({ kind, id }) => ({ kind, id })) }) });
      return true;
    });
    // Refused: no new state will arrive to put the order back, so put it back here.
    if (!saved && current().workspace?.pins === next) set({ workspace: { ...current().workspace!, pins: ws.pins } });
  },
  /** Open (or, with null, close) the tag box in a session's top line. */
  startTagging: (id: string | null) => set({ tagging: id }),
  addTag: (id: string, tag: string) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/tags`, { method: 'POST', body: JSON.stringify({ tag }) })),
  removeTag: (id: string, tag: string) => act(() => call(`/api/sessions/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })),
  renameSession: (id: string, title: string) => act(() => call(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) })),
  renameProject: (id: string, name: string) => act(() => call(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })),
  /** Archive or restore a session, a project or a group. */
  archive: (kind: 'session' | 'project' | 'group', id: string, archived = true) =>
    act(async () => {
      const send = (skipScript: boolean) => call('/api/archive', { method: 'POST', body: JSON.stringify({ kind, id, archived, ...(skipScript ? { skipScript } : {}) }) });
      try {
        await send(false);
      } catch (error) {
        // The project's archive script failed (shared/project-scripts.ts): show why, and offer to archive without it.
        const failed = (error as { archiveScript?: { output: string } }).archiveScript;
        if (!failed) throw error;
        const output = failed.output ? `\n\nIts output ended:\n${failed.output}` : '';
        if (window.confirm(`${messageFor(error)}${output}\n\nArchive the session anyway, without running the script?`)) await send(true);
      }
    }),
  /** Delete a session for good, after asking. Its worktree folder goes too, and its branch when nothing is lost with it. */
  deleteSession(session: { id: string; title: string; worktreePath: string | null }): void {
    const worktree = session.worktreePath ? `\n\nIts worktree folder is removed too, with anything in it that was never committed. Its branch is deleted only if its commits are already in the main checkout's branch; otherwise it stays in the repository.` : '';
    if (window.confirm(`Delete “${session.title}” for good? Its conversation cannot be brought back.${worktree}`)) void act(() => call(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }));
  },
  /** Show a folder in Finder; in a browser, where there is none, copy its path. */
  async reveal(path: string): Promise<void> {
    if (window.kestrelShell) await window.kestrelShell.reveal(path);
    else await navigator.clipboard.writeText(path).catch(() => undefined);
  },
  renameWorkstream: (id: string, name: string) => act(() => call(`/api/workstreams/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })),
  /** Say what a workstream is for; an empty objective clears it. */
  setWorkstreamObjective: (id: string, objective: string) => act(() => call(`/api/workstreams/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ objective }) })),
  /** Take a session out of a workstream. Only the reference goes; the session stays where it is filed. */
  removeFromWorkstream: (id: string, sessionId: string) => act(() => call(`/api/workstreams/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })),
  /** Mark a workstream's work finished, or not finished after all. */
  setWorkstreamStatus: (id: string, status: 'active' | 'complete') => act(() => call(`/api/workstreams/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) })),
  /** Archive a workstream (out of the sidebar, still searchable) or restore it. Its sessions are not touched. */
  /** `withSessions`: a restore that also brings back the sessions archived with it. */
  archiveWorkstream: (id: string, archived: boolean, withSessions = false) => act(() => call(`/api/workstreams/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(withSessions ? { archived, sessions: true } : { archived }) })),
  stopWorkstream: (id: string) => act(() => call<{ stopped: number }>(`/api/workstreams/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' })),
  /** Delete a workstream, after asking. Its sessions stay where they are: only the grouping goes. */
  deleteWorkstream(workstream: { id: string; name: string; sessionIds: readonly string[] }): void {
    const n = workstream.sessionIds.length;
    if (window.confirm(`Delete the workstream “${workstream.name}”? Its ${n} session${n === 1 ? '' : 's'} stay where they are; only the grouping goes.`)) void act(() => call(`/api/workstreams/${encodeURIComponent(workstream.id)}`, { method: 'DELETE' }));
  },
  /** Delete a folder; its sessions stay, ungrouped. Asks first when it holds sessions. */
  deleteFolder(group: Group, sessionCount: number): void {
    if (window.confirm(sessionCount === 0 ? `Delete the group “${group.name}”?` : `Delete the group “${group.name}”? Its ${sessionCount} session${sessionCount === 1 ? '' : 's'} stay in the list, ungrouped.`)) void actions.deleteGroup(group.id);
  },
};

// ---- drafts: kept per session, on this machine ------------------------------------

const DRAFT_PREFIX = 'kestrel.draft.';
export const drafts = {
  get(id: string): string {
    try {
      return localStorage.getItem(DRAFT_PREFIX + id) ?? '';
    } catch {
      return '';
    }
  },
  set(id: string, text: string): void {
    try {
      if (text) localStorage.setItem(DRAFT_PREFIX + id, text);
      else localStorage.removeItem(DRAFT_PREFIX + id);
    } catch {
      // Storage unavailable: the draft lives only in the textarea.
    }
  },
};
