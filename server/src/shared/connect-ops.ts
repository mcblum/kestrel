// Kestrel Connect: the closed list of what a paired phone may ask of this computer, and the envelope
// every frame between two devices travels in (docs/designs/kestrel-connect.md, sections 4 and 6).
// One definition: the dispatcher (connect/dispatcher.ts) carries out only what is named here, and a
// request for anything else is refused with a reason the phone shows. Adding an operation is a
// design change, not a code change. Pure: no Node, so a client written from this file can share it.
import type { PageAsk } from './transcript-page.ts';

/** The protocol version this copy of Kestrel speaks. A frame of any other version is refused. */
export const CONNECT_PROTOCOL_VERSION = 1;

export const ENVELOPE_KINDS = ['request', 'response', 'push', 'hello', 'bye'] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

/**
 * One frame between two devices of an account. `body` is ciphertext on the wire (the service never
 * reads it); once decrypted it is the kind's own shape (`ConnectRequest`, `ConnectResponse`, a push).
 */
export interface Envelope<B = unknown> {
  v: number;
  from: string;
  to: string;
  kind: EnvelopeKind;
  id: string;
  /** For a `response`: the `id` of the request it answers. */
  replyTo?: string;
  body: B;
}

/** Device ids and frame ids: what a service and a device make, nothing that could be a path. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isConnectId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * Why a device cannot read a frame of version `v`, said for the device that sent it, or null when it
 * can. `here` names this computer ("your Mac"), so a phone ahead of it knows what to update.
 */
export function versionRefusal(v: number, here: string): string | null {
  if (v === CONNECT_PROTOCOL_VERSION) return null;
  return v > CONNECT_PROTOCOL_VERSION ? `Update Kestrel on ${here}: it speaks Kestrel Connect ${CONNECT_PROTOCOL_VERSION}, and this device speaks ${v}.` : `Update Kestrel on this device: ${here} speaks Kestrel Connect ${CONNECT_PROTOCOL_VERSION}, and this device speaks ${v}.`;
}

/** Checks a decoded frame's envelope. The body is left to its kind; the version is checked by `versionRefusal`. */
export function checkEnvelope(raw: unknown): Checked<Envelope> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('A frame must be an object.');
  const e = raw as Record<string, unknown>;
  if (typeof e.v !== 'number' || !Number.isInteger(e.v) || e.v < 1) return fail('A frame needs its protocol version, v, a whole number from 1.');
  if (!isConnectId(e.from)) return fail('A frame needs from, the id of the device that sent it.');
  if (!isConnectId(e.to)) return fail('A frame needs to, the id of the device it is for.');
  if (!ENVELOPE_KINDS.includes(e.kind as EnvelopeKind)) return fail(`A frame's kind must be one of ${ENVELOPE_KINDS.join(', ')}.`);
  if (!isConnectId(e.id)) return fail('A frame needs id, made of letters, digits, - and _.');
  if (e.kind === 'response' && !isConnectId(e.replyTo)) return fail('A response needs replyTo, the id of the request it answers.');
  if (e.kind !== 'response' && e.replyTo !== undefined) return fail('Only a response carries replyTo.');
  if (!('body' in e)) return fail('A frame needs a body.');
  const known = new Set(['v', 'from', 'to', 'kind', 'id', 'replyTo', 'body']);
  const extra = Object.keys(e).find((k) => !known.has(k));
  if (extra) return fail(`A frame has nothing called ${extra}.`);
  return { ok: true, value: { v: e.v, from: e.from, to: e.to, kind: e.kind as EnvelopeKind, id: e.id, ...(e.kind === 'response' ? { replyTo: e.replyTo as string } : {}), body: e.body } };
}

// ---- the operations ------------------------------------------------------------------------

/** The most messages one page of a conversation holds, and how many a page holds when none is asked. */
export const PAGE_MAX = 200;
export const PAGE_DEFAULT = 50;
/** As the message box: a message is at most this many characters. */
export const MESSAGE_MAX = 20_000;
/** As one attached file (shared/attachments.ts, ATTACHMENT_MAX_FILE_BYTES), counted in base64. */
export const PHOTO_MAX_BASE64 = Math.ceil((20 * 1024 * 1024 * 4) / 3) + 4;


export interface ConnectOpArgs {
  'state.read': Record<string, never>;
  'session.read': { sessionId: string; page: PageAsk };
  'session.watch': { sessionId: string };
  'session.unwatch': { sessionId: string };
  'session.attach': { draftId: string; name: string; mediaType: string; data: string };
  'session.reply': { sessionId: string; text: string; draftId?: string; attachments?: string[] };
  'session.answer': { sessionId: string; requestId: string; optionId?: string; text?: string; answers?: Record<string, string> };
  'session.stop': { sessionId: string };
  'session.seen': { sessionId: string };
  'media.read': { sessionId: string; name: string };
  'attachment.read': { sessionId: string; attachmentId: string };
  /** Checked by ReviewReplies.post, as the desk's are: the same edits and the same refusals. */
  'review.post': { sessionId: string; cardId: string; verdict?: unknown; summary?: unknown; findings?: unknown; withoutComment?: unknown };
  /** A suggestion card in the conversation (a tag, a ticket change, a move, a review offer): one of its buttons, its x, or Undo on the line it left. */
  'suggestion.answer': { sessionId: string; suggestionId: string; button: string };
  'suggestion.dismiss': { sessionId: string; suggestionId: string };
  'suggestion.undo': { sessionId: string; suggestionId: string };
}
export type ConnectOp = keyof ConnectOpArgs;

/** A decrypted request body: one operation and its arguments. */
export type ConnectRequest = { [K in ConnectOp]: { op: K; args: ConnectOpArgs[K] } }[ConnectOp];
/** A decrypted response body. A refusal carries the reason the phone shows. */
export type ConnectResponse = { ok: true; result: unknown } | { ok: false; reason: string };

type Args = Record<string, unknown>;
const KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const id = (a: Args, field: string): Checked<string> => (typeof a[field] === 'string' && KEY.test(a[field] as string) ? { ok: true, value: a[field] as string } : fail(`${field} must be an id.`));
const optional = <T>(a: Args, field: string, check: (a: Args, f: string) => Checked<T>): Checked<T | undefined> => (a[field] === undefined ? { ok: true, value: undefined } : check(a, field));
const text = (max: number, allowEmpty = false) => (a: Args, field: string): Checked<string> =>
  typeof a[field] === 'string' && (a[field] as string).length <= max && (allowEmpty || (a[field] as string).trim() !== '') ? { ok: true, value: a[field] as string } : fail(`${field} must be ${allowEmpty ? '' : 'non-empty '}text of at most ${max} characters.`);
const count = (a: Args, field: string): Checked<number> =>
  Number.isInteger(a[field]) && (a[field] as number) >= 1 && (a[field] as number) <= PAGE_MAX ? { ok: true, value: a[field] as number } : fail(`${field} must be a whole number from 1 to ${PAGE_MAX}.`);

/** The files a message names: `draftId` and the ids uploaded to it with `session.attach`. Checked again by the runtime. */
function files(a: Args): Checked<{ draftId?: string; attachments?: string[] }> {
  if (a.attachments === undefined) return a.draftId === undefined ? { ok: true, value: {} } : fail('draftId goes with attachments.');
  if (!Array.isArray(a.attachments) || a.attachments.some((x) => typeof x !== 'string' || !KEY.test(x))) return fail('attachments must be a list of attachment ids.');
  const draft = id(a, 'draftId');
  return draft.ok ? { ok: true, value: { draftId: draft.value, attachments: a.attachments as string[] } } : fail('draftId must name the draft the photos were attached to.');
}

/** Which page of a conversation `last`, or `before` and `limit`, ask for; the end when none is given. */
export function checkPage(a: Args): Checked<PageAsk> {
  if (a.before !== undefined) {
    const before = id(a, 'before');
    if (!before.ok) return before;
    const limit = a.limit === undefined ? { ok: true as const, value: PAGE_DEFAULT } : count(a, 'limit');
    return limit.ok ? { ok: true, value: { before: before.value, limit: limit.value } } : limit;
  }
  if (a.limit !== undefined) return fail('limit goes with before; for the end of a conversation give last.');
  const last = a.last === undefined ? { ok: true as const, value: PAGE_DEFAULT } : count(a, 'last');
  return last.ok ? { ok: true, value: { last: last.value } } : last;
}

function answers(a: Args): Checked<Record<string, string> | undefined> {
  const value = a.answers;
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('answers must be an object of question -> answer.');
  const entries = Object.entries(value as Args);
  if (entries.length > 8 || entries.some(([q, x]) => q.length > 500 || typeof x !== 'string' || x.length > 2000)) return fail('answers must be at most 8 questions, each answered with text of at most 2000 characters.');
  return { ok: true, value: value as Record<string, string> };
}

/** Runs field checks in order; the first failure is the answer. */
function all(checks: Record<string, Checked<unknown>>): Checked<Args> {
  const out: Args = {};
  for (const [field, c] of Object.entries(checks)) {
    if (!c.ok) return c;
    if (c.value !== undefined) out[field] = c.value;
  }
  return { ok: true, value: out };
}

const spread = (c: Checked<Args>): Record<string, Checked<unknown>> => (c.ok ? Object.fromEntries(Object.entries(c.value).map(([k, v]) => [k, { ok: true, value: v }])) : { files: c });

interface OpSpec {
  /** What it maps to on the desktop: the route whose functions it calls. */
  mapsTo: string;
  /** The fields it takes; anything else is refused. */
  fields: readonly string[];
  check: (a: Args) => Checked<Args>;
}

/** The list (spec section 4). Closed: a request for anything not here is refused. */
export const CONNECT_OPS: { readonly [K in ConnectOp]: OpSpec } = {
  'state.read': { mapsTo: 'GET /api/state', fields: [], check: () => ({ ok: true, value: {} }) },
  'session.read': {
    mapsTo: 'GET /api/sessions/:id, a page at a time',
    fields: ['sessionId', 'last', 'before', 'limit'],
    check: (a) => all({ sessionId: id(a, 'sessionId'), page: checkPage(a) }),
  },
  'session.watch': { mapsTo: 'the watch message and live patches', fields: ['sessionId'], check: (a) => all({ sessionId: id(a, 'sessionId') }) },
  'session.unwatch': { mapsTo: 'the unwatch message', fields: ['sessionId'], check: (a) => all({ sessionId: id(a, 'sessionId') }) },
  'session.attach': {
    mapsTo: 'POST /api/attachments/drafts/:draftId (photos only, never a path)',
    fields: ['draftId', 'name', 'mediaType', 'data'],
    check: (a) =>
      all({
        draftId: id(a, 'draftId'),
        name: text(200)(a, 'name'),
        mediaType: typeof a.mediaType === 'string' && /^image\/[a-z0-9.+-]{1,40}$/.test(a.mediaType) ? { ok: true, value: a.mediaType } : fail('Only photos can be sent from a phone: mediaType must be image/….'),
        data: typeof a.data === 'string' && a.data.length > 0 && a.data.length <= PHOTO_MAX_BASE64 && /^[A-Za-z0-9+/]*={0,2}$/.test(a.data) ? { ok: true, value: a.data } : fail('data must be the photo in base64, at most 20 MB.'),
      }),
  },
  'session.reply': {
    mapsTo: 'POST /api/sessions/:id/reply',
    fields: ['sessionId', 'text', 'draftId', 'attachments'],
    check: (a) => {
      const f = files(a);
      return all({ sessionId: id(a, 'sessionId'), text: text(MESSAGE_MAX, f.ok && f.value.attachments !== undefined)(a, 'text'), ...spread(f) });
    },
  },
  'session.answer': {
    mapsTo: 'POST /api/sessions/:id/answer',
    fields: ['sessionId', 'requestId', 'optionId', 'text', 'answers'],
    check: (a) => all({ sessionId: id(a, 'sessionId'), requestId: id(a, 'requestId'), optionId: optional(a, 'optionId', id), text: optional(a, 'text', text(2000, true)), answers: answers(a) }),
  },
  'session.stop': { mapsTo: 'POST /api/sessions/:id/stop', fields: ['sessionId'], check: (a) => all({ sessionId: id(a, 'sessionId') }) },
  'session.seen': { mapsTo: 'POST /api/seen (the one seen map, pushed to every window)', fields: ['sessionId'], check: (a) => all({ sessionId: id(a, 'sessionId') }) },
  'media.read': { mapsTo: 'GET /api/sessions/:id/media/:name', fields: ['sessionId', 'name'], check: (a) => all({ sessionId: id(a, 'sessionId'), name: id(a, 'name') }) },
  'attachment.read': { mapsTo: 'GET /api/sessions/:id/attachments/:id', fields: ['sessionId', 'attachmentId'], check: (a) => all({ sessionId: id(a, 'sessionId'), attachmentId: id(a, 'attachmentId') }) },
  'review.post': {
    mapsTo: 'POST /api/sessions/:id/review-reply',
    fields: ['sessionId', 'cardId', 'verdict', 'summary', 'findings', 'withoutComment'],
    // The edits are passed on as they came: ReviewReplies.post checks them, for the desk and a phone alike.
    check: (a) => all({ sessionId: id(a, 'sessionId'), cardId: id(a, 'cardId'), verdict: { ok: true, value: a.verdict }, summary: { ok: true, value: a.summary }, findings: { ok: true, value: a.findings }, withoutComment: { ok: true, value: a.withoutComment } }),
  },
  // A suggestion card is in the chat window, so a phone answers it as the desk does (Matt, 2026-11-22: "if it's
  // in the chat window, the phone can interact with it"). Each calls what the suggestion route calls, for
  // every kind alike; a kind's own refusals (Kestrel-only, nothing to undo) are the phone's too.
  'suggestion.answer': {
    mapsTo: 'POST /api/sessions/:id/suggestions/:sid/answer',
    fields: ['sessionId', 'suggestionId', 'button'],
    check: (a) => all({ sessionId: id(a, 'sessionId'), suggestionId: id(a, 'suggestionId'), button: id(a, 'button') }),
  },
  'suggestion.dismiss': { mapsTo: 'POST /api/sessions/:id/suggestions/:sid/dismiss', fields: ['sessionId', 'suggestionId'], check: (a) => all({ sessionId: id(a, 'sessionId'), suggestionId: id(a, 'suggestionId') }) },
  'suggestion.undo': { mapsTo: 'POST /api/sessions/:id/suggestions/:sid/undo', fields: ['sessionId', 'suggestionId'], check: (a) => all({ sessionId: id(a, 'sessionId'), suggestionId: id(a, 'suggestionId') }) },
};

export const CONNECT_OP_NAMES = Object.keys(CONNECT_OPS) as ConnectOp[];
export const isConnectOp = (value: unknown): value is ConnectOp => typeof value === 'string' && Object.hasOwn(CONNECT_OPS, value);

/**
 * What is never done from a phone, whatever the account says (spec section 4). Not operations: the
 * reasons a request for one of these is refused, so the phone can say why.
 */
export const NEVER_REMOTE: Readonly<Record<string, string>> = {
  terminal: 'The terminal is only at the desk.',
  browser: 'The browser pane is only at the desk.',
  simulator: 'The simulator pane is only at the desk.',
  files: 'Files are not read by path from a phone.',
  settings: 'Settings are changed at the desk.',
  'sandbox-allow': 'The always-allowed list is edited in Settings at the desk. From a phone, a sandbox card\'s own choices add to it.',
  'project-edits': '"Keep each project\'s edits in its own session" is changed at the desk.',
  'review-mode': 'How reviews start is changed at the desk.',
  'session.start': 'Sessions are started at the desk. From a phone you can answer one an agent asks to start.',
  'session.rename': 'A session is renamed at the desk.',
  'session.move': 'A session is moved at the desk.',
  'session.archive': 'A session is archived at the desk.',
  'session.model': 'A session\'s model is changed at the desk.',
  'session.permission': 'A session\'s mode is changed at the desk.',
  pair: 'Devices are paired at a desk or an already-paired phone, never by a request.',
};

/** Checks a decrypted request body against the list. Anything not on it is refused with a reason. */
export function checkRequest(raw: unknown): Checked<ConnectRequest> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('A request must be an object with op and args.');
  const { op, args = {} } = raw as { op?: unknown; args?: unknown };
  if (!isConnectOp(op)) {
    const never = typeof op === 'string' ? Object.entries(NEVER_REMOTE).find(([k]) => op === k || op.startsWith(`${k}.`)) : undefined;
    return fail(never ? never[1] : `A phone cannot ask for ${typeof op === 'string' ? `"${op.slice(0, 60)}"` : 'that'}: it is not something Kestrel Connect does.`);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail('args must be an object.');
  const spec = CONNECT_OPS[op];
  const extra = Object.keys(args).find((k) => !spec.fields.includes(k));
  if (extra) return fail(`${op} takes no ${extra.slice(0, 60)}.`);
  const checked = spec.check(args as Args);
  if (!checked.ok) return checked;
  const value = op === 'session.read' ? { sessionId: checked.value.sessionId, page: checked.value.page } : checked.value;
  return { ok: true, value: { op, args: value } as ConnectRequest };
}
