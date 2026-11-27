// Acting on a session that runs on another computer of the account (issue 47; account-sessions.md, section 9.2).
// The window calls the same routes for a session here or there; for one there, http.ts hands the route to this
// module, which asks that computer the matching operation of the closed list (`CONNECT_OPS`) over the caller's
// sealed channel. That computer's dispatcher carries it out by what its own routes call, with its own checks;
// its refusal comes back here with its reason. Nothing is added to the list: a route with no operation is refused
// with where the session runs (`remoteRefusal`), as before. Nothing is held or retried when the computer cannot be
// reached (issue 53): the action is refused, naming it, and the window keeps what was typed.
import { randomUUID } from 'node:crypto';
import { draftRefs } from './attachments/api.ts';
import type { AttachmentStore } from './attachments/store.ts';
import type { RemoteAnswer } from './connect/link/remote-sessions.ts';
import { checkRequest, type ConnectOp } from './shared/connect-ops.ts';
import { remoteRefusal, unreachableRefusal, type Machine } from './shared/machines.ts';
import { Refused } from './refused.ts';

export interface RemoteActionDeps {
  /** Asks the session's machine one operation of the list (`RemoteSessions.ask`). */
  ask: (machine: string, op: ConnectOp, args: Record<string, unknown>) => Promise<RemoteAnswer>;
  /** This computer's drafts, whose files a reply carries there; null where there are none. */
  drafts: Pick<AttachmentStore, 'draftFiles' | 'removeDraft'> | null;
}

export type ActionAnswer = { status: number; body?: unknown };

export type Body = Record<string, unknown>;

/** One route as the operation it maps to: its arguments from the body, and its answer in the route's own shape. */
interface Mapped {
  op: ConnectOp;
  args: Body;
  /** The local route's answer from the operation's result; 204 when the route answers nothing. */
  shape: (result: unknown) => ActionAnswer;
}

const field = (result: unknown, name: string): unknown => (typeof result === 'object' && result !== null ? (result as Body)[name] : undefined);
const asIs = (result: unknown): ActionAnswer => ({ status: 200, body: result });
const nothing = (): ActionAnswer => ({ status: 204 });
/** Only what was given: a field left out stays out, as the route reads it. */
const given = (body: Body, names: readonly string[]): Body => Object.fromEntries(names.filter((n) => body[n] !== undefined).map((n) => [n, body[n]]));

/** What a reply may not carry from here: a model or mode is changed on the computer the session runs on (issue 52). */
const CHANGES = ['model', 'permission', 'effort', 'fast'] as const;

/** The operation a session route maps to, or null when the list has none for it. */
function mapRoute(parts: readonly string[], sessionId: string, body: Body): Mapped | null {
  const [what, sub, action] = [parts[3], parts[4], parts[5]];
  if (parts.length === 6 && what === 'suggestions' && sub) {
    const suggestionId = decodeURIComponent(sub);
    const shape = asIs;
    if (action === 'answer') return { op: 'suggestion.answer', args: { sessionId, suggestionId, ...given(body, ['button', 'picks']) }, shape };
    if (action === 'dismiss') return { op: 'suggestion.dismiss', args: { sessionId, suggestionId }, shape };
    if (action === 'undo') return { op: 'suggestion.undo', args: { sessionId, suggestionId }, shape };
    return null;
  }
  if (parts.length !== 4) return null;
  switch (what) {
    case 'answer':
      return { op: 'session.answer', args: { sessionId, ...given(body, ['requestId', 'optionId', 'text', 'answers']) }, shape: nothing };
    case 'stop':
      return { op: 'session.stop', args: { sessionId }, shape: nothing };
    case 'compact':
      return { op: 'session.compact', args: { sessionId }, shape: asIs };
    case 'autopilot':
      return { op: 'autopilot.set', args: { sessionId, ...given(body, ['on', 'merge']) }, shape: asIs };
    case 'review-reply':
      return { op: 'review.post', args: { sessionId, ...given(body, ['cardId', 'verdict', 'summary', 'findings', 'withoutComment']) }, shape: (result) => ({ status: 200, body: field(result, 'review') }) };
    case 'findings':
      return { op: 'findings.act', args: { sessionId, ...given(body, ['cardId', 'findingId', 'action', 'text']) }, shape: asIs };
    case 'review-end':
      return { op: 'reviewEnd.act', args: { sessionId, ...given(body, ['cardId', 'action', 'findingIds']) }, shape: asIs };
    default:
      return null;
  }
}

/** Why an answer that is not one is refused: the computer's own reason, or that it could not be reached. */
function refusal(answer: Extract<RemoteAnswer, { ok: false }>, machine: Machine): ActionAnswer {
  return answer.reached ? { status: 409, body: { error: answer.reason } } : { status: 503, body: { error: unreachableRefusal(machine.name, answer.reason) } };
}

/** Asks one operation, checked first against the list as the other computer will check it. */
export async function asked(machine: Machine, op: ConnectOp, args: Body, deps: RemoteActionDeps): Promise<{ ok: true; result: unknown } | { ok: false; answer: ActionAnswer }> {
  const checked = checkRequest({ op, args });
  if (!checked.ok) return { ok: false, answer: { status: 400, body: { error: checked.reason } } };
  const answer = await deps.ask(machine.id, op, args);
  return answer.ok ? answer : { ok: false, answer: refusal(answer, machine) };
}

/**
 * The pictures of this computer's draft, sent to a draft of `machine`'s (`session.attach` each): the draft there and
 * their ids, or the answer that refuses them. The list's `session.attach` takes pictures only: a phone's photos.
 */
export async function sendPictures(machine: Machine, body: Body, deps: RemoteActionDeps): Promise<{ ok: true; attached: { draftId: string; attachments: string[] } | null } | { ok: false; answer: ActionAnswer }> {
  const refs = draftRefs(body);
  const files = refs ? (deps.drafts ?? noDrafts()).draftFiles(refs) : [];
  const notPicture = files.find((f) => f.attachment.kind !== 'image');
  if (notPicture) return { ok: false, answer: { status: 409, body: { error: `Only pictures can go with a message to a session on ${machine.name}. ${notPicture.attachment.name} is not one.` } } };
  if (files.length === 0) return { ok: true, attached: null };
  const draftId = randomUUID();
  const ids: string[] = [];
  for (const { attachment, bytes } of files) {
    const sent = await asked(machine, 'session.attach', { draftId, name: attachment.name, mediaType: attachment.mediaType, data: bytes.toString('base64') }, deps);
    if (!sent.ok) return sent;
    const id = field(sent.result, 'id');
    if (typeof id !== 'string') return { ok: false, answer: { status: 502, body: { error: `${machine.name} did not say where it kept ${attachment.name}.` } } };
    ids.push(id);
  }
  return { ok: true, attached: { draftId, attachments: ids } };
}

/**
 * A reply, with its files: each picture of this computer's draft is sent there first (`sendPictures`), then the
 * message names them (`session.reply`). The draft here is dropped only once the message went, so a refused or
 * unreached reply keeps its files in the box.
 */
async function reply(machine: Machine, sessionId: string, body: Body, deps: RemoteActionDeps): Promise<ActionAnswer> {
  const change = CHANGES.find((c) => body[c] !== undefined);
  if (change) return { status: 409, body: { error: `This session runs on ${machine.name}. Its model and mode are changed there.` } };
  const pictures = await sendPictures(machine, body, deps);
  if (!pictures.ok) return pictures.answer;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const went = await asked(machine, 'session.reply', { sessionId, text, ...(pictures.attached ?? {}) }, deps);
  if (!went.ok) return went.answer;
  const refs = draftRefs(body);
  if (refs) deps.drafts?.removeDraft(refs.draftId);
  return { status: 200, body: { outcome: field(went.result, 'outcome') } };
}

function noDrafts(): never {
  throw new Refused('Files cannot be attached here: Kestrel has no agent runtime running.');
}

/**
 * Answers `/api/sessions/:id/...` for a session that runs on `machine`: carried out there through its operation,
 * or refused with where it runs when the list has none. Reading it is the route's own (remote-conversation.ts).
 */
export async function remoteActionRoute(parts: readonly string[], method: string, readBody: () => Promise<Body>, sessionId: string, machine: Machine, deps: RemoteActionDeps): Promise<ActionAnswer> {
  if (method === 'POST' && parts.length === 4 && parts[3] === 'reply') return reply(machine, sessionId, await readBody(), deps);
  const mapped = method === 'POST' ? mapRoute(parts, sessionId, await readBody()) : null;
  if (!mapped) return { status: 409, body: { error: remoteRefusal(machine.name) } };
  const done = await asked(machine, mapped.op, mapped.args, deps);
  return done.ok ? mapped.shape(done.result) : done.answer;
}
