// New session on another computer of the account (issue 52; account-sessions.md, "Starting a session on another
// computer, as built"). The window's New session box sends `POST /api/sessions` with `machine` naming the computer;
// http.ts hands it here, and it is asked of that computer as `session.start`, the operation a phone uses (A8), over
// the caller's sealed channel. That computer checks it as its own box's start is checked, with its switch, and
// answers with the new session's id or its refusal, which is shown in its words. Nothing is added to the list.
//
// On success the new session is put in this computer's replica at once from the answer (a provisional head), so its
// page opens here before the service has the head; the head that computer uploads replaces it.
import { randomUUID } from 'node:crypto';
import { draftRefs } from './attachments/api.ts';
import type { Project } from './model.ts';
import { asked, failedRemoteAction, sendPictures, type ActionAnswer, type Body, type RemoteActionDeps } from './remote-actions.ts';
import { BYPASS_FROM_ELSEWHERE, checkRequest } from './shared/connect-ops.ts';
import type { AccountHead, Machine } from './shared/machines.ts';
import { asStartChoices, cloneOn, doesNotHave, projectOn, startMayHaveHappened, type RemoteStartChoices } from './shared/start-computer.ts';

/**
 * How long a start on another computer is waited for. Not the 5 s of a call (CALL_TIMEOUT_MS): that computer answers
 * once it has accepted the start and made the session's row, and before that it may have to wake an agent to check
 * the model (a worker node's first start is cold) and, for a project it clones, ask the git host whether its key may
 * read each repository (`LS_REMOTE_TIMEOUT_MS`). The clone itself and the agent's start come after the answer.
 */
export const START_TIMEOUT_MS = 60_000;
/** A start that got no answer in time is asked once more, with the same id, before anything is said (item 81). */
export const START_TRIES = 2;

/** The account's other computers a session may start on, and how one is asked an operation (Kestrel Connect's caller). */
export interface StartComputers {
  list: () => Machine[];
  ask: RemoteActionDeps['ask'];
}

export interface RemoteStartDeps extends RemoteActionDeps {
  /** The projects as the window lists them (`Workspace.view()`), to find the project's id on that computer. */
  projects: readonly Project[];
  /** A project of this computer's repository keys (repo-keys.ts), for the provisional head. */
  reposOf: (project: Project) => Promise<string[]>;
  /** Puts the provisional head in the replica (`AccountReplica.started`). */
  started: (machine: Machine, head: AccountHead) => Promise<void>;
  now: () => number;
  /** What that computer published that it offers (its `offers` record), or null: where a project it can clone is found. */
  offersOf?: (machine: Machine) => Promise<RemoteStartChoices | null>;
  /** How long each try waits: `START_TIMEOUT_MS` unless a test makes it shorter. */
  startTimeoutMs?: number;
}

/**
 * The start id: the window's, when it sent one (the same for every Enter on one draft, so a second Enter after "did
 * not answer in time" cannot start a second session), else one made here.
 */
const startIdOf = (body: Body): string => (typeof body.startId === 'string' && checkRequest({ op: 'session.start', args: { text: 'x', startId: body.startId } }).ok ? body.startId : randomUUID());

/**
 * `session.start` asked of `machine`, waited for as long as a start takes, and asked again with the same id when no
 * answer came in time: that computer answers a repeat with the session the first made. When the last try is late
 * too, it may have started there, and the words say so.
 */
async function askStart(machine: Machine, args: Body, deps: RemoteStartDeps): Promise<{ ok: true; result: unknown } | { ok: false; answer: ActionAnswer }> {
  const checked = checkRequest({ op: 'session.start', args });
  if (!checked.ok) return { ok: false, answer: { status: 400, body: { error: checked.reason } } };
  for (let tries = 1; ; tries++) {
    const answer = await deps.ask(machine.id, 'session.start', args, { timeoutMs: deps.startTimeoutMs ?? START_TIMEOUT_MS });
    if (answer.ok) return answer;
    if (!answer.late) return { ok: false, answer: failedRemoteAction(answer, machine.name) };
    if (tries >= START_TRIES) return { ok: false, answer: { status: 504, body: { error: startMayHaveHappened(machine.name) } } };
  }
}

/** The title shown until that computer's head arrives: what it answered, else the message's first line. */
const TITLE_MAX = 80;
function provisionalTitle(answered: unknown, text: string): string {
  if (typeof answered === 'string' && answered.trim()) return answered;
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line || 'New session';
}

const refused = (status: number, error: string): ActionAnswer => ({ status, body: { error } });

/** Why a body cannot start a session on `machine` before anything is asked of it, or null. */
function bodyRefusal(body: Body, machine: Machine): string | null {
  if (body.permission === 'bypass') return BYPASS_FROM_ELSEWHERE;
  if (body.permission !== 'ask' && body.permission !== 'auto') return `A session on ${machine.name} starts in Manual or Auto from here.`;
  if (body.folderId !== undefined && body.folderId !== null) return `The folder is chosen on ${machine.name}: a session started there from here starts in its project's default folder.`;
  if (body.groupId !== undefined && body.groupId !== null) return `A session on ${machine.name} cannot be put in a group here yet.`;
  if (body.purpose !== undefined) return `Set up this computer's agent runs on the computer it sets up.`;
  return null;
}

/**
 * Before pictures are sent there, what that computer already says it would refuse (`session.startChoices`): its
 * switch is off, or it cannot start the agent asked for. No operation takes back a picture sent for a start it then
 * refuses, so a start it is known to refuse sends none. Asked only when there are pictures to send.
 */
async function knownRefusal(machine: Machine, body: Body, deps: RemoteActionDeps): Promise<ActionAnswer | null> {
  const choices = await asked(machine, 'session.startChoices', {}, deps);
  if (!choices.ok) return choices.answer;
  const there = asStartChoices(choices.result);
  if (!there) return null;
  if (!there.allowed) return refused(409, there.refusal ?? `Starting sessions on ${machine.name} from other devices is off in its Settings.`);
  const missing = there.missing.find((m) => m.agent === body.agent);
  return missing ? refused(409, missing.reason) : null;
}

/**
 * Starts a session on `machine` from the New session box's body (`prompt`, `agent`, `model`, `permission`,
 * `projectId` as listed here, and the draft's pictures). The answer is the route's own: 201 with the session's id
 * and where it runs, or the refusal with its reason (409 from there, 503 when it cannot be reached).
 */
export async function remoteStartRoute(body: Body, machine: Machine, deps: RemoteStartDeps): Promise<ActionAnswer> {
  const wrong = bodyRefusal(body, machine);
  if (wrong) return refused(409, wrong);
  const project = typeof body.projectId === 'string' && body.projectId ? deps.projects.find((p) => p.id === body.projectId) : null;
  if (project === undefined) return refused(409, 'That project is not listed here any more.');
  const has = project ? projectOn(project, machine.id) : null;
  // A project it does not have but has said it would clone when a session starts there (a worker node, item 64).
  const clone = has === undefined && project && deps.offersOf ? cloneOn(project, await deps.offersOf(machine)) : undefined;
  const theirs = has !== undefined ? has : clone?.id;
  if (theirs === undefined) return refused(409, doesNotHave(machine.name, project!.name));

  if (draftRefs(body)) {
    const known = await knownRefusal(machine, body, deps);
    if (known) return known;
  }
  const pictures = await sendPictures(machine, body, deps);
  if (!pictures.ok) return pictures.answer;
  const text = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const args: Body = {
    text,
    ...(theirs !== null ? { projectId: theirs } : {}),
    ...(body.agent !== undefined ? { agent: body.agent } : {}),
    ...(body.agent !== undefined && typeof body.model === 'string' ? { model: body.model } : {}),
    mode: body.permission,
    ...(pictures.attached ?? {}),
    startId: startIdOf(body),
  };
  const went = await askStart(machine, args, deps);
  if (!went.ok) return went.answer;
  const result = (typeof went.result === 'object' && went.result !== null ? went.result : {}) as Body;
  const sessionId = result.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return refused(502, `${machine.name} started the session but did not say which it is.`);
  const refs = draftRefs(body);
  if (refs) deps.drafts?.removeDraft(refs.draftId);

  const now = deps.now();
  const repos = project ? (project.away ? (project.elsewhere?.repos ?? []) : await deps.reposOf(project)) : [];
  await deps.started(machine, {
    id: sessionId,
    runsOn: machine.id,
    title: provisionalTitle(result.title, text),
    agent: result.agent === 'claude' || result.agent === 'codex' || result.agent === 'opencode' ? result.agent : body.agent === 'codex' || body.agent === 'opencode' ? body.agent : 'claude',
    state: 'running',
    // What its row says while it starts there ("Cloning acme/shop…"), until its own head arrives.
    note: typeof result.note === 'string' ? result.note : '',
    project: project && theirs ? { id: theirs, name: project.name } : null,
    repos,
    filing: project ? 'started' : 'unscoped',
    branch: null,
    request: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    messages: 0,
    chunks: 0,
  });
  return { status: 201, body: { id: sessionId, runsOn: machine.id } };
}
