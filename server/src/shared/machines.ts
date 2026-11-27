// Sessions that run on another computer of the account (docs/designs/account-sessions.md, sections 5.2
// and 9.1). A head is what one machine says about one of its sessions; this computer keeps the heads of
// the others in its replica and draws them beside its own. What another machine sends is read through
// the parsers here and nowhere else: it is sealed under the account key, but it is still outside data.
import type { Agent, ChangedFile, ChatMessage, FilingStatus, LivePatch, SessionQueue, SessionSettings, SessionState } from '../model.ts';
import { asHeadLink, asHeadWorkstream, type HeadLink, type HeadWorkstream } from './account-workstreams.ts';
import { isPermissionLevel } from './permissions.ts';
import type { PullRequestState } from './details.ts';

const AGENTS: readonly Agent[] = ['claude', 'codex', 'opencode'];
const STATES: readonly SessionState[] = ['running', 'attention', 'done', 'interrupted'];
const FILINGS: readonly FilingStatus[] = ['landed', 'pending', 'started', 'unscoped', 'hidden'];
const REQUESTS: readonly PullRequestState[] = ['draft', 'open', 'merged', 'closed'];

/** A computer of the account, as the others name it. */
export interface Machine {
  id: string;
  name: string;
}

/** One session of another machine: the entry of that machine's held index, with where it runs. */
export interface AccountHead {
  id: string;
  /** The machine it runs on (its device id in the account). */
  runsOn: string;
  title: string;
  agent: Agent;
  state: SessionState;
  note: string;
  /** Its project on that machine: that machine's id for it, and its name. Null for a session with no project. */
  project: { id: string; name: string } | null;
  /** Set on a guest: the session whose worktree it works in. */
  hostId?: string;
  /** The repositories its project is, as every computer names them (repo-keys.ts); empty for a plain folder. */
  repos: string[];
  /** How its machine filed it, from the git evidence only that machine has. */
  filing: FilingStatus;
  branch: string | null;
  /** The last-seen state of its newest pull request, or null. */
  request: PullRequestState | null;
  stopped?: boolean;
  completedAt?: number;
  /**
   * Archived on its machine (Matt, 2026-11-27: "Archive should be allowed from anywhere"): every device lists it under
   * Archived, not in the sidebar, and can restore it. Its conversation is no longer held; only this head is.
   */
  archived?: true;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  /** How many messages its conversation has, and in how many chunks they are held. */
  messages: number;
  chunks: number;
  /**
   * Its model, effort, fast mode and mode as its machine last said them (issue 79): a window here shows them from the
   * account's copy at once, whether or not that machine can be reached now. Absent from an older machine's head.
   */
  settings?: SessionSettings;
  /** The session that started it and how, when that session's head is published too (issue 83). Absent from an older machine's head. */
  link?: HeadLink;
  /** The workstream it is in, as its machine holds it (shared/account-workstreams.ts). */
  workstream?: HeadWorkstream;
}

/** A head as its machine holds it on the service: one sealed record per session, saying which machine wrote it. */
export interface HeadRecord {
  machine: Machine;
  head: AccountHead;
}

/** What a head's record is filed under, before tagging: its id, and the list every head is in. */
export const headLabel = (sessionId: string): string => `head|${sessionId}`;
export const HEADS_LIST = 'heads';

/** One held chunk of a conversation: its place and its messages. */
export interface AccountChunk {
  n: number;
  messages: ChatMessage[];
}

/** Where a session runs, as every route and view asks it. */
export type Whereabouts = { here: true } | { here: false; machine: Machine; online: boolean };

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function asHead(raw: unknown, runsOn: string): AccountHead | null {
  const r = obj(raw);
  if (!r) return null;
  const id = text(r.id);
  const title = text(r.title);
  const createdAt = count(r.createdAt);
  const updatedAt = count(r.updatedAt);
  if (!id || title === null || createdAt === null || updatedAt === null) return null;
  if (!AGENTS.includes(r.agent as Agent) || !STATES.includes(r.state as SessionState)) return null;
  const p = obj(r.project);
  const projectId = p && text(p.id);
  const hostId = text(r.hostId);
  return {
    id,
    runsOn,
    title,
    agent: r.agent as Agent,
    state: r.state as SessionState,
    note: text(r.note) ?? '',
    project: p && projectId ? { id: projectId, name: text(p.name) ?? '' } : null,
    ...(hostId ? { hostId } : {}),
    repos: Array.isArray(r.repos) ? r.repos.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 300).slice(0, 20) : [],
    // A head from before filing travelled: where it says its project is.
    filing: FILINGS.includes(r.filing as FilingStatus) ? (r.filing as FilingStatus) : p && projectId ? 'started' : 'unscoped',
    branch: text(r.branch) || null,
    request: REQUESTS.includes(r.request as PullRequestState) ? (r.request as PullRequestState) : null,
    ...(r.stopped === true ? { stopped: true } : {}),
    ...(count(r.completedAt) !== null ? { completedAt: r.completedAt as number } : {}),
    ...(r.archived === true ? { archived: true as const } : {}),
    createdAt,
    updatedAt,
    lastActivityAt: count(r.lastActivityAt) ?? updatedAt,
    messages: count(r.messages) ?? 0,
    chunks: count(r.chunks) ?? 0,
    ...(asSessionSettings(r.settings) ? { settings: asSessionSettings(r.settings)! } : {}),
    ...linkAndWorkstream(r),
  };
}

function linkAndWorkstream(r: Record<string, unknown>): Pick<AccountHead, 'link' | 'workstream'> {
  const link = asHeadLink(r.link);
  const workstream = asHeadWorkstream(r.workstream);
  return { ...(link ? { link } : {}), ...(workstream ? { workstream } : {}) };
}

/**
 * A head's record as opened, or null when it is not one. Which machine may say it runs the session, and
 * which record id it must be under, are the caller's to check.
 */
export function asHeadRecord(raw: unknown): HeadRecord | null {
  const r = obj(raw);
  const machine = r && obj(r.machine);
  const id = machine && text(machine.id);
  if (!r || !machine || !id || r.kind !== 'head') return null;
  const head = asHead(r.session, id);
  return head && { machine: { id, name: text(machine.name) || 'Another computer' }, head };
}

/** A held chunk as opened, or null when it is not chunk `n` of that session. */
export function asAccountChunk(raw: unknown, sessionId: string, n: number): AccountChunk | null {
  const r = obj(raw);
  if (!r || r.kind !== 'chunk' || r.sessionId !== sessionId || r.n !== n || !Array.isArray(r.messages)) return null;
  return { n, messages: asMessages(r.messages) };
}

/** The messages of a list another machine sent: anything that is not one is left out. */
function asMessages(raw: readonly unknown[]): ChatMessage[] {
  return raw.filter((m): m is ChatMessage => {
    const message = obj(m);
    return message !== null && (message.author === 'you' || message.author === 'agent') && typeof message.text === 'string' && (message.id === undefined || typeof message.id === 'string');
  });
}

/** One page of a conversation as another machine answered `session.read` (shared/transcript-page.ts). */
export interface RemotePage {
  messages: ChatMessage[];
  before: string | null;
  total: number;
}

/** A `session.read` answer as opened, or null when it is not one. */
export function asRemotePage(raw: unknown): RemotePage | null {
  const r = obj(raw);
  if (!r || !Array.isArray(r.messages) || (r.before !== null && typeof r.before !== 'string') || count(r.total) === null) return null;
  return { messages: asMessages(r.messages), before: r.before as string | null, total: r.total as number };
}

/**
 * What of another machine's live patch is shown here: the conversation and what the agent is doing now, and what the
 * page draws beside it (account-sessions.md, "A session on another computer drawn as one here"): the model and mode,
 * the queue, how full the context window is, the changed files as carried, the commands, background work, helpers and
 * slash commands. Each part is taken only in the shape it must have; anything else is left out. Null when nothing is left.
 */
export function asRemotePatch(raw: unknown): LivePatch | null {
  const r = obj(raw);
  if (!r) return null;
  const removed = Array.isArray(r.removedMessages) ? r.removedMessages.filter((id): id is string => typeof id === 'string') : [];
  const list = <K extends keyof LivePatch>(key: K): Partial<LivePatch> => (Array.isArray(r[key]) ? { [key]: (r[key] as unknown[]).filter((x) => obj(x) !== null) } : {});
  const out: LivePatch = {
    ...(Array.isArray(r.messages) ? { messages: asMessages(r.messages) } : {}),
    ...(removed.length > 0 ? { removedMessages: removed } : {}),
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
    ...(asSessionSettings(r.settings) ? { settings: asSessionSettings(r.settings)! } : {}),
    ...(asQueue(r.queue) ? { queue: asQueue(r.queue)! } : {}),
    ...(r.context === null || obj(r.context) ? { context: r.context as LivePatch['context'] } : {}),
    ...(Array.isArray(r.files) ? { files: asFiles(r.files) } : {}),
    ...(r.filesProblem === null || typeof r.filesProblem === 'string' ? { filesProblem: r.filesProblem } : {}),
    ...(r.subagentsAfter === null || typeof r.subagentsAfter === 'string' ? { subagentsAfter: r.subagentsAfter } : {}),
    ...(r.kestrelTools === 'connected' || r.kestrelTools === 'missing' || r.kestrelTools === 'unknown' ? { kestrelTools: r.kestrelTools } : {}),
    ...(Array.isArray(r.kestrelMissing) ? { kestrelMissing: r.kestrelMissing.filter((x): x is string => typeof x === 'string') } : {}),
    ...list('subagents'),
    ...list('backgroundTasks'),
    ...list('commands'),
    ...list('slashCommands'),
    ...list('mcpServers'),
  };
  return Object.keys(out).length > 0 ? out : null;
}

/** A session's model and mode as another machine sent them (a head, a live patch, the held queue's own file), or null. */
export function asSessionSettings(raw: unknown): SessionSettings | null {
  const r = obj(raw);
  if (!r || typeof r.model !== 'string' || !isPermissionLevel(r.permission)) return null;
  return { model: r.model, permission: r.permission, ...(typeof r.effort === 'string' ? { effort: r.effort } : {}), ...(typeof r.fast === 'boolean' ? { fast: r.fast } : {}) };
}

/** The held messages as another machine sent them, or null. */
function asQueue(raw: unknown): SessionQueue | null {
  const r = obj(raw);
  if (!r || !Array.isArray(r.items) || typeof r.held !== 'boolean') return null;
  return { ...r, items: r.items.filter((x) => obj(x) !== null), held: r.held } as SessionQueue;
}

/** The changed files as another machine carried them: each with a path, a status and its diff (or what was held back). */
function asFiles(raw: readonly unknown[]): ChangedFile[] {
  return raw.flatMap((f) => {
    const o = obj(f);
    if (!o || typeof o.path !== 'string' || (o.status !== 'M' && o.status !== 'A' && o.status !== 'D') || typeof o.diff !== 'string') return [];
    return [{ path: o.path, status: o.status, diff: o.diff, ...(typeof o.heldBack === 'number' ? { heldBack: o.heldBack } : {}) }];
  });
}

/** Why something that needs a session's own machine is refused on another, naming where it runs. */
export function remoteRefusal(machineName: string): string {
  return `This session runs on ${machineName}. That can only be done there.`;
}

/**
 * Another machine's refusal as it is shown: its own words, or, when it gave none, that it refused (item 81: an empty
 * reason once reached the window as an empty toast). Every refusal of a remote action is worded through this.
 */
export function refusedThere(machineName: string, reason: unknown): string {
  const said = typeof reason === 'string' ? reason.trim() : '';
  return said || `${machineName} refused that without saying why. Look at Kestrel there.`;
}

/**
 * Why an action on a session on another machine was not done: that machine could not be reached ("Mac mini cannot
 * be reached."), with why the link said so. Nothing is held for later (that is issue 53).
 */
export function unreachableRefusal(machineName: string, why: string): string {
  const reason = why.trim();
  return `${machineName} cannot be reached, so nothing was done there.${reason ? ` ${reason}` : ''} Try again when it is back.`;
}

/** Why something read from a session's own machine is not shown: that machine could not be reached. Nothing is held for later. */
export function notReachedRead(what: string, machineName: string): string {
  return `${machineName} cannot be reached, so ${what} cannot be shown now. Try again when it is back.`;
}

/** Why a session's model and mode cannot be changed from here now: its machine could not be reached (issue 79). */
export function notReachedSettings(machineName: string): string {
  return `${machineName} cannot be reached, so this session's model and mode cannot be changed from here now. Try again when it is back.`;
}

/** What of a head says its conversation changed: kept with the chunks fetched, and compared before fetching again. */
export function conversationStamp(head: Pick<AccountHead, 'lastActivityAt' | 'messages' | 'chunks'>): string {
  return `${head.lastActivityAt}|${head.messages}|${head.chunks}`;
}

/** The machine of that id among those known, or a stand-in that says only that it is another computer. */
export function whereIsMachine(id: string, machines: readonly Machine[]): Machine {
  return machines.find((m) => m.id === id) ?? { id, name: 'another computer' };
}

/** The panes that stay on the computer a session runs on: its shells, its browser and its simulator are that computer's. */
export type PaneThere = 'terminal' | 'browser' | 'simulator';
const PANE_THERE: Record<PaneThere, string> = { terminal: 'The terminal', browser: 'The browser pane', simulator: 'The simulator' };

/** Why such a pane, or running a code block, cannot be had here: "The terminal is on Mac mini." */
export const paneThere = (pane: PaneThere, machine: string): string => `${PANE_THERE[pane]} is on ${machine}.`;

/**
 * Where a session runs: here, or on another machine of the account, online or not. A session with no
 * `runsOn` is this computer's own.
 */
export function whereIs(session: { runsOn?: string }, machines: readonly Machine[], online: ReadonlySet<string>): Whereabouts {
  if (!session.runsOn) return { here: true };
  const machine = whereIsMachine(session.runsOn, machines);
  return { here: false, machine, online: online.has(machine.id) };
}

/**
 * The line at the top of a remote conversation whose copy here is behind and whose machine was asked for the rest and
 * did not answer: "Mac mini did not answer. Shown as of 14:02; anything newer is still on Mac mini." The time is
 * when this computer last read the conversation from the account; a day other than today is named. Never "asleep":
 * whether a machine is asleep is not known here (presence is a later stage).
 */
export function notAnsweredText(machineName: string, asOf: number | null, now: number = Date.now()): string {
  const said = `${machineName} did not answer.`;
  const rest = `anything newer is still on ${machineName}.`;
  if (asOf === null) return `${said} Anything newer than what is shown is still on ${machineName}.`;
  const at = new Date(asOf);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = at.toDateString() === new Date(now).toDateString();
  return `${said} Shown as of ${today ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`}; ${rest}`;
}
