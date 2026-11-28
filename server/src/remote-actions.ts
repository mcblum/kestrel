// Acting on a session that runs on another computer of the account (issue 47; account-sessions.md, section 9.2, and
// "A session on another computer drawn as one here, as built"). The window calls the same routes for a session here or
// there; for one there, http.ts hands the route to this module, which asks that computer the matching operation of the
// closed list (`CONNECT_OPS`) over the caller's sealed channel. That computer's dispatcher carries it out by what its
// own routes call, with its own checks; its refusal comes back here with its reason. A route with no operation is
// refused with where the session runs (`remoteRefusal`). Nothing is held or retried when the computer cannot be reached
// (issue 53): the action is refused, naming it, and the window keeps what was typed.
import { randomUUID } from 'node:crypto';
import { draftRefs } from './attachments/api.ts';
import type { AttachmentStore } from './attachments/store.ts';
import type { RemoteAnswer } from './connect/link/remote-sessions.ts';
import { decodedSegment } from './request-fields.ts';
import { checkRequest, SESSION_SECTIONS, type ConnectOp, type SessionSection } from './shared/connect-ops.ts';
import { refusedThere, remoteRefusal, unreachableRefusal, type Machine } from './shared/machines.ts';
import { tooLargeToBring } from './shared/remote-carry.ts';
import { Refused } from './refused.ts';

export interface RemoteActionDeps {
  /** Asks the session's machine one operation of the list (`RemoteSessions.ask`). */
  ask: (machine: string, op: ConnectOp, args: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<RemoteAnswer>;
  /** This computer's drafts, whose files a reply carries there; null where there are none. */
  drafts: Pick<AttachmentStore, 'draftFiles' | 'removeDraft'> | null;
  /** A session that computer just made from this one (a fork): listed here at once, until its own head arrives. */
  listed?: (machine: Machine, fromSessionId: string, made: Body) => Promise<void>;
}

export type ActionAnswer = { status: number; body?: unknown };
/** A route's answer for a session there: a JSON body, or a file's bytes (a document tab, a picture in a message). */
export type RemoteRouteAnswer = ActionAnswer | { status: 200; type: string; bytes: Buffer };

export type Body = Record<string, unknown>;

/** One route as the operation it maps to: its arguments from the request, and its answer in the route's own shape. */
interface Mapped {
  op: ConnectOp;
  args: Body;
  /** The local route's answer from the operation's result; 204 when the route answers nothing. */
  shape: (result: unknown, machine: Machine) => RemoteRouteAnswer;
}

/** What one route is asked with: its method, path parts, query, and its body read once. */
interface Asked {
  parts: readonly string[];
  method: string;
  url: URL;
  body: Body;
  sessionId: string;
}

const field = (result: unknown, name: string): unknown => (typeof result === 'object' && result !== null ? (result as Body)[name] : undefined);
const asIs = (result: unknown): ActionAnswer => ({ status: 200, body: result });
const created = (result: unknown): ActionAnswer => ({ status: 201, body: result });
const nothing = (): ActionAnswer => ({ status: 204 });
/**
 * An archive done, or its project's archive script failing there: then the same 409 a session here answers, with the
 * script's output, so the window offers to archive without it (`skipScript`).
 */
const archived = (result: unknown): ActionAnswer => {
  const failed = field(result, 'archiveScript') as { reason?: unknown; output?: unknown } | undefined;
  if (!failed || typeof failed.reason !== 'string') return { status: 204 };
  return { status: 409, body: { error: failed.reason, archiveScript: { output: typeof failed.output === 'string' ? failed.output : '' } } };
};
/** A file's bytes as that computer sent them, or that it was too large to bring over, naming where it is. */
const bytes = (result: unknown, machine: Machine): RemoteRouteAnswer => {
  const type = field(result, 'type');
  const data = field(result, 'data');
  if (typeof type === 'string' && typeof data === 'string') return { status: 200, type, bytes: Buffer.from(data, 'base64') };
  if (typeof field(result, 'tooLarge') === 'number') return { status: 413, body: { error: tooLargeToBring('That file', machine.name) } };
  return { status: 502, body: { error: `${machine.name} answered with something that is not a file.` } };
};
/** Only what was given: a field left out stays out, as the route reads it. */
const given = (body: Body, names: readonly string[]): Body => Object.fromEntries(names.filter((n) => body[n] !== undefined).map((n) => [n, body[n]]));
/** A query value, when it is there. */
const query = (url: URL, name: string): Body => (url.searchParams.has(name) ? { [name]: url.searchParams.get(name) ?? '' } : {});

/** The routes with an item after what they act on (`commands/:id/stop`, `suggestions/:id/answer`). */
function itemRoute({ parts, method, body, sessionId }: Asked): Mapped | null {
  const [what, sub, action] = [parts[3], parts[4], parts[5]];
  if (!sub) return null;
  const item = decodedSegment(sub);
  if (what === 'suggestions' && method === 'POST') {
    const suggestionId = item;
    if (action === 'answer') return { op: 'suggestion.answer', args: { sessionId, suggestionId, ...given(body, ['button', 'picks', 'toggles']) }, shape: asIs };
    if (action === 'dismiss') return { op: 'suggestion.dismiss', args: { sessionId, suggestionId }, shape: asIs };
    if (action === 'undo') return { op: 'suggestion.undo', args: { sessionId, suggestionId }, shape: asIs };
  }
  if (what === 'background-tasks' && action === 'stop' && method === 'POST') return { op: 'background.stop', args: { sessionId, taskId: item }, shape: nothing };
  if (what === 'commands' && action === 'output' && method === 'GET') return { op: 'command.output', args: { sessionId, commandId: item }, shape: asIs };
  if (what === 'commands' && action === 'retry' && method === 'POST') return { op: 'command.retry', args: { sessionId, commandId: item }, shape: asIs };
  if (what === 'commands' && action === 'stop' && method === 'POST') return { op: 'command.stop', args: { sessionId, commandId: item }, shape: nothing };
  return null;
}

/** The reads of the session's page beside its conversation. */
function readRoute({ parts, url, sessionId }: Asked): Mapped | null {
  const what = parts[3]!;
  if (SESSION_SECTIONS.includes(what as SessionSection)) return { op: 'session.details', args: { sessionId, section: what, ...(url.searchParams.get('refresh') === '1' ? { refresh: true } : {}) }, shape: asIs };
  const path = { path: url.searchParams.get('path') ?? '' };
  switch (what) {
    case 'context':
      return { op: 'session.context', args: { sessionId }, shape: asIs };
    case 'files':
      return { op: 'session.files', args: { sessionId, ...path, ...query(url, 'folder') }, shape: asIs };
    case 'file':
      return { op: 'session.file', args: { sessionId, ...path, ...query(url, 'folder') }, shape: asIs };
    case 'document':
      return { op: 'session.document', args: { sessionId, ...path }, shape: bytes };
    case 'document-place':
      return { op: 'session.documentPlace', args: { sessionId, ...path }, shape: asIs };
    case 'raw':
      return { op: 'session.raw', args: { sessionId, ...path }, shape: bytes };
    case 'review':
      return { op: 'session.reviewOf', args: { sessionId }, shape: asIs };
    default:
      return null;
  }
}

/** The actions of the conversation and the page: a button the window shows, as the route takes it. */
function actionRoute({ parts, body, sessionId }: Asked): Mapped | null {
  switch (parts[3]) {
    case 'answer':
      return { op: 'session.answer', args: { sessionId, ...given(body, ['requestId', 'optionId', 'text', 'answers', 'confirmed']) }, shape: nothing };
    case 'stop':
      return { op: 'session.stop', args: { sessionId }, shape: nothing };
    case 'archive':
      return { op: 'session.archive', args: { sessionId, archived: body.archived !== false, ...(body.skipScript === true ? { skipScript: true } : {}) }, shape: archived };
    case 'compact':
      return { op: 'session.compact', args: { sessionId }, shape: asIs };
    case 'autopilot':
      return { op: 'autopilot.set', args: { sessionId, ...given(body, ['on', 'merge', 'watch']) }, shape: asIs };
    case 'review-reply':
      return { op: 'review.post', args: { sessionId, ...given(body, ['cardId', 'verdict', 'summary', 'findings', 'withoutComment']) }, shape: (result) => ({ status: 200, body: field(result, 'review') }) };
    case 'findings':
      return { op: 'findings.act', args: { sessionId, ...given(body, ['cardId', 'findingId', 'action', 'text']) }, shape: asIs };
    case 'review-end':
      return { op: 'reviewEnd.act', args: { sessionId, ...given(body, ['cardId', 'action', 'findingIds']) }, shape: asIs };
    case 'tags':
      return { op: 'session.tag', args: { sessionId, tag: body.tag, on: true }, shape: asIs };
    case 'role':
      return { op: 'session.role', args: { sessionId, ...given(body, ['role', 'brief']) }, shape: asIs };
    case 'review':
      return { op: 'session.review', args: { sessionId, comment: body.comment === true }, shape: asIs };
    case 'fork':
      return { op: 'session.fork', args: { sessionId, ...given(body, ['turn']) }, shape: created };
    case 'pr-prepare':
      return { op: 'pr.prepare', args: { sessionId, generated: body.generated === true }, shape: asIs };
    case 'pr-create':
      return { op: 'pr.create', args: { sessionId, ...given(body, ['title', 'body', 'base', 'draft', 'autopilot']) }, shape: asIs };
    case 'pr-merge-preview':
      return { op: 'pr.mergePreview', args: { sessionId, ...given(body, ['number']) }, shape: asIs };
    case 'pr-merge':
      return { op: 'pr.merge', args: { sessionId, ...given(body, ['number', 'sha', 'base', 'method']) }, shape: asIs };
    default:
      return null;
  }
}

/** The operation a session route maps to, or null when the list has none for it. */
export function mapRoute(asked: Asked): Mapped | null {
  const { parts, method, body, sessionId } = asked;
  if (parts.length === 3 && method === 'PATCH') return { op: 'session.rename', args: { sessionId, title: typeof body.title === 'string' ? body.title.trim() : body.title }, shape: nothing };
  if (parts.length === 3 && method === 'DELETE') return { op: 'session.delete', args: { sessionId }, shape: nothing };
  if (parts.length === 6) return itemRoute(asked);
  if (parts.length === 5 && parts[3] === 'queue' && parts[4]) {
    if (method === 'POST' && parts[4] === 'send') return { op: 'queue.send', args: { sessionId }, shape: nothing };
    if (method === 'DELETE') return { op: 'queue.remove', args: { sessionId, messageId: decodedSegment(parts[4]) }, shape: nothing };
  }
  if (parts.length === 5 && parts[3] === 'tags' && parts[4] && method === 'DELETE') return { op: 'session.tag', args: { sessionId, tag: decodedSegment(parts[4]), on: false }, shape: asIs };
  if (parts.length !== 4) return null;
  if (method === 'GET') return readRoute(asked);
  return method === 'POST' ? actionRoute(asked) : null;
}

/**
 * How a failed remote action is answered to the window: the computer's own reason (409), or that it could not be
 * reached (503). Never without words: a refusal with an empty reason says that it refused (`refusedThere`).
 */
export function failedRemoteAction(answer: Extract<RemoteAnswer, { ok: false }>, machineName: string): ActionAnswer {
  return answer.reached ? { status: 409, body: { error: refusedThere(machineName, answer.reason) } } : { status: 503, body: { error: unreachableRefusal(machineName, answer.reason) } };
}

/** Asks one operation, checked first against the list as the other computer will check it. */
export async function asked(machine: Machine, op: ConnectOp, args: Body, deps: RemoteActionDeps): Promise<{ ok: true; result: unknown } | { ok: false; answer: ActionAnswer }> {
  const checked = checkRequest({ op, args });
  if (!checked.ok) return { ok: false, answer: { status: 400, body: { error: checked.reason } } };
  const answer = await deps.ask(machine.id, op, args);
  return answer.ok ? answer : { ok: false, answer: failedRemoteAction(answer, machine.name) };
}

/**
 * The files of this computer's draft, sent to a draft of `machine`'s: the draft there and their ids, or the answer that
 * refuses them. A picture goes as a phone's photo does (`session.attach`); with `anyFile`, any other file the message
 * box takes goes too (`session.attachFile`, a desktop's). A start elsewhere carries pictures only.
 */
export async function sendFiles(machine: Machine, body: Body, deps: RemoteActionDeps, anyFile = false): Promise<{ ok: true; attached: { draftId: string; attachments: string[] } | null } | { ok: false; answer: ActionAnswer }> {
  const refs = draftRefs(body);
  const files = refs ? (deps.drafts ?? noDrafts()).draftFiles(refs) : [];
  const notPicture = anyFile ? undefined : files.find((f) => f.attachment.kind !== 'image');
  if (notPicture) return { ok: false, answer: { status: 409, body: { error: `Only pictures can go with a message to a session on ${machine.name}. ${notPicture.attachment.name} is not one.` } } };
  if (files.length === 0) return { ok: true, attached: null };
  const draftId = randomUUID();
  const ids: string[] = [];
  for (const { attachment, bytes: data } of files) {
    const op = attachment.kind === 'image' ? 'session.attach' : 'session.attachFile';
    const sent = await asked(machine, op, { draftId, name: attachment.name, mediaType: attachment.mediaType, data: data.toString('base64') }, deps);
    if (!sent.ok) return sent;
    const id = field(sent.result, 'id');
    if (typeof id !== 'string') return { ok: false, answer: { status: 502, body: { error: `${machine.name} did not say where it kept ${attachment.name}.` } } };
    ids.push(id);
  }
  return { ok: true, attached: { draftId, attachments: ids } };
}

/** As `sendFiles`, pictures only: what a start on another computer carries. */
export const sendPictures = (machine: Machine, body: Body, deps: RemoteActionDeps) => sendFiles(machine, body, deps);

/**
 * A reply, with its files and the model, effort, fast mode or mode that ride on it, as the window's own reply carries
 * them: each file of this computer's draft is sent there first (`sendFiles`), then the message names them
 * (`session.reply`). Bypass is refused here before anything is sent, and there again. The draft here is dropped only
 * once the message went, so a refused or unreached reply keeps its files in the box.
 */
async function reply(machine: Machine, sessionId: string, body: Body, deps: RemoteActionDeps): Promise<ActionAnswer> {
  const change = given(body, ['model', 'permission', 'effort', 'fast']);
  const checked = checkRequest({ op: 'session.reply', args: { sessionId, text: typeof body.text === 'string' && body.text.trim() ? body.text : 'x', ...change } });
  if (!checked.ok) return { status: 400, body: { error: checked.reason } };
  const files = await sendFiles(machine, body, deps, true);
  if (!files.ok) return files.answer;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const went = await asked(machine, 'session.reply', { sessionId, text, ...(files.attached ?? {}), ...change }, deps);
  if (!went.ok) return went.answer;
  const refs = draftRefs(body);
  if (refs) deps.drafts?.removeDraft(refs.draftId);
  return { status: 200, body: { outcome: field(went.result, 'outcome') } };
}

function noDrafts(): never {
  throw new Refused('Files cannot be attached here: Kestrel has no agent runtime running.');
}

/**
 * Answers `/api/sessions/:id/...` for a session that runs on `machine`: carried out there through its operation, or
 * refused with where it runs when the list has none. Reading its conversation is the route's own (remote-conversation.ts).
 */
export async function remoteActionRoute(parts: readonly string[], method: string, readBody: () => Promise<Body>, sessionId: string, machine: Machine, deps: RemoteActionDeps, url: URL = new URL('http://kestrel/')): Promise<RemoteRouteAnswer> {
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody();
  if (method === 'POST' && parts.length === 4 && parts[3] === 'reply') return reply(machine, sessionId, body, deps);
  const mapped = mapRoute({ parts, method, url, body, sessionId });
  if (!mapped) return { status: 409, body: { error: remoteRefusal(machine.name) } };
  const done = await asked(machine, mapped.op, mapped.args, deps);
  if (!done.ok) return done.answer;
  const answer = mapped.shape(done.result, machine);
  if (mapped.op === 'session.fork' && 'body' in answer && deps.listed) await deps.listed(machine, sessionId, (answer.body ?? {}) as Body);
  return answer;
}
