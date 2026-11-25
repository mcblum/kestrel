// Kestrel Connect: the closed list of what a paired phone may ask of this computer, and the envelope
// every frame between two devices travels in (docs/designs/kestrel-connect.md, sections 4 and 6).
// One definition: the dispatcher (connect/dispatcher.ts) carries out only what is named here, and a
// request for anything else is refused with a reason the phone shows. Adding an operation is a
// design change, not a code change. Pure: no Node, so a client written from this file can share it.
import { ANSWER_MAX, FINDING_ACTIONS, type FindingAction } from './findings.ts';
import { REVIEW_END_ACTIONS, type ReviewEndAction } from './round-findings.ts';
import { isPicks } from './suggestions.ts';
import type { PageAsk } from './transcript-page.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';

/** The protocol version this copy of Kestrel speaks. A frame of any other version is refused. */
/** 2: frames sealed with AES-256-GCM (1 was ChaCha20-Poly1305, which the app's Electron cannot do). */
export const CONNECT_PROTOCOL_VERSION = 3;

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
  /** Compact the conversation (Matt, 2026-11-24): what the window's Compact button does. */
  'session.compact': { sessionId: string };
  'session.seen': { sessionId: string };
  /**
   * A new session on this computer, from a blank page (A8; account-sessions.md section 11, stage 6). The phone
   * picks the machine by which desk it sends this to. A preset or an agent, else the New session box's choices
   * here; the mode Manual (`ask`) or Auto, else the box's, never Bypass.
   */
  'session.start': { projectId?: string; folderId?: string; presetId?: string; agent?: Agent; model?: string; mode?: 'ask' | 'auto'; text: string; draftId?: string; attachments?: string[] };
  /** What `session.start` may pick from here: this computer's switch, its agents and presets, and what its New session box starts with. */
  'session.startChoices': Record<string, never>;
  'media.read': { sessionId: string; name: string };
  'attachment.read': { sessionId: string; attachmentId: string };
  /** Checked by ReviewReplies.post, as the desk's are: the same edits and the same refusals. */
  'review.post': { sessionId: string; cardId: string; verdict?: unknown; summary?: unknown; findings?: unknown; withoutComment?: unknown };
  /** A suggestion card in the conversation (a tag, a ticket change, a move, a review offer): one of its buttons, its x, or Undo on the line it left. */
  /** `picks`: what was chosen on a card that offers names to choose (`Suggestion.picks`: a tag card's tags). Left out, the card's own choice is taken. */
  'suggestion.answer': { sessionId: string; suggestionId: string; button: string; picks?: string[] };
  'suggestion.dismiss': { sessionId: string; suggestionId: string };
  'suggestion.undo': { sessionId: string; suggestionId: string };
  /** Autopilot for the session's pull request: on, off, or Merge when green (docs/designs/pr-autopilot.md). */
  'autopilot.set': { sessionId: string; on: boolean; merge?: boolean };
  /** The Code reviews page's list, as the window has it, or off in the desk's words (Matt, 2026-11-24). */
  'reviews.read': Record<string, never>;
  /** The Tickets page's list, as the window has it, or off in the desk's words (Matt, 2026-11-24). */
  'tickets.read': Record<string, never>;
  // The pages' buttons (Matt, 2026-11-24; kestrel-connect.md, "Actions"): each calls what the desk's does.
  'reviews.seen': { keys: string[]; seen: boolean };
  'reviews.dismiss': { keys: string[]; dismissed: boolean };
  'reviews.start': { key: string };
  'tickets.seen': { keys: string[]; seen: boolean };
  'tickets.dismiss': { keys: string[]; dismissed: boolean };
  'tickets.statuses': { key: string };
  'tickets.move': { key: string; to: string };
  'tickets.comment': { key: string; body: string };
  'tickets.detail': { key: string };
  'tickets.work': { key: string };
  /** A session's pull request and what needs the user, as the window has them (2026-11-24). */
  'pullRequests.read': Record<string, never>;
  /** One finding of a review card: answer its question, ask for it to be fixed, dismiss it or take it back (2026-11-24). */
  'findings.act': { sessionId: string; cardId: string; findingId: string; action: FindingAction; text?: string };
  /** The card left when a review of a session's own work ended with findings open: fix, carry on, or undo that (2026-11-24). */
  'reviewEnd.act': { sessionId: string; cardId: string; action: ReviewEndAction; findingIds?: string[] };
}

/** As many findings as one Fix sends (the review-end route's own limit). */
export const FINDING_IDS_MAX = 50;
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

/** A review request's or a ticket's key (`github.com/acme/shop#12`, `jira:site/PLAT-1`), as the stores take them. */
const RECORD_KEY_MAX = 300;
/** As many keys as one Dismiss all or Mark read sends. */
export const KEYS_MAX = 200;
const recordKey = (a: Args, field: string): Checked<string> => (typeof a[field] === 'string' && (a[field] as string).length > 0 && (a[field] as string).length <= RECORD_KEY_MAX ? { ok: true, value: a[field] as string } : fail(`${field} must be a key of at most ${RECORD_KEY_MAX} characters.`));
const recordKeys = (a: Args, field: string): Checked<string[]> => {
  const v = a[field];
  return Array.isArray(v) && v.length >= 1 && v.length <= KEYS_MAX && v.every((k) => typeof k === 'string' && k.length > 0 && k.length <= RECORD_KEY_MAX) ? { ok: true, value: v as string[] } : fail(`${field} must be a list of 1 to ${KEYS_MAX} keys.`);
};
/** A model id as an agent's list has it ('' is the agent's own default; OpenCode's are `provider/model`). Which ones exist is the desk's to check. */
const MODEL_ID_MAX = 300;
const modelId = (a: Args, field: string): Checked<string> => (typeof a[field] === 'string' && (a[field] as string).length <= MODEL_ID_MAX && !/[\u0000-\u001f]/.test(a[field] as string) ? { ok: true, value: a[field] as string } : fail(`${field} must be a model id of at most ${MODEL_ID_MAX} characters.`));
const oneOf = <T extends string>(names: readonly T[]) => (a: Args, field: string): Checked<T> => (names.includes(a[field] as T) ? { ok: true, value: a[field] as T } : fail(`${field} must be one of: ${names.join(', ')}.`));
const ids = (max: number) => (a: Args, field: string): Checked<string[]> => {
  const v = a[field];
  return Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && KEY.test(x)) ? { ok: true, value: v as string[] } : fail(`${field} must be a list of at most ${max} ids.`);
};
const flag = (a: Args, field: string): Checked<boolean> => (typeof a[field] === 'boolean' ? { ok: true, value: a[field] as boolean } : fail(`${field} must be true or false.`));

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
const picks = (a: Args, field: string): Checked<string[]> => (isPicks(a[field]) ? { ok: true, value: a[field] } : fail(`${field} must be a short list of names.`));

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
  // Matt, 2026-11-24: "Within the context stuff, there should be a button to trigger compacting the convo"
  // (kestrel-connect.md, "The context window, and Compact"). The same call the window's button makes.
  'session.compact': { mapsTo: 'POST /api/sessions/:id/compact', fields: ['sessionId'], check: (a) => all({ sessionId: id(a, 'sessionId') }) },
  // Matt, 2026-11-24: "add the ability for the phone to start a new session on any worker" (A8, stage 6).
  'session.start': {
    mapsTo: 'POST /api/sessions (A8: this computer\'s switch, never Bypass)',
    fields: ['projectId', 'folderId', 'presetId', 'agent', 'model', 'mode', 'text', 'draftId', 'attachments'],
    check: (a) => {
      if (a.mode === 'bypass') return fail(BYPASS_FROM_ELSEWHERE);
      if (a.presetId !== undefined && (a.agent !== undefined || a.model !== undefined)) return fail('Give a preset or an agent, not both.');
      if (a.model !== undefined && a.agent === undefined) return fail('Say which agent the model is for.');
      const f = files(a);
      return all({
        projectId: optional(a, 'projectId', id),
        folderId: optional(a, 'folderId', id),
        presetId: optional(a, 'presetId', id),
        agent: optional(a, 'agent', oneOf(SELECTABLE_AGENTS)),
        model: optional(a, 'model', modelId),
        mode: optional(a, 'mode', oneOf(['ask', 'auto'] as const)),
        text: text(MESSAGE_MAX, f.ok && f.value.attachments !== undefined)(a, 'text'),
        ...spread(f),
      });
    },
  },
  'session.startChoices': { mapsTo: 'the New session box\'s choices and Settings → Workflow\'s switch', fields: [], check: () => ({ ok: true, value: {} }) },
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
    fields: ['sessionId', 'suggestionId', 'button', 'picks'],
    // Only the shape is checked here, as the route does (`isPicks`): what each name may be is the kind's to say, for the desk and a phone alike.
    check: (a) => all({ sessionId: id(a, 'sessionId'), suggestionId: id(a, 'suggestionId'), button: id(a, 'button'), picks: optional(a, 'picks', picks) }),
  },
  'suggestion.dismiss': { mapsTo: 'POST /api/sessions/:id/suggestions/:sid/dismiss', fields: ['sessionId', 'suggestionId'], check: (a) => all({ sessionId: id(a, 'sessionId'), suggestionId: id(a, 'suggestionId') }) },
  'suggestion.undo': { mapsTo: 'POST /api/sessions/:id/suggestions/:sid/undo', fields: ['sessionId', 'suggestionId'], check: (a) => all({ sessionId: id(a, 'sessionId'), suggestionId: id(a, 'suggestionId') }) },
  // Matt, 2026-11-24 (pr-autopilot.md section 4): the request pill's Autopilot entry, as the desk has it.
  'autopilot.set': { mapsTo: 'POST /api/sessions/:id/autopilot', fields: ['sessionId', 'on', 'merge'], check: (a) => all({ sessionId: id(a, 'sessionId'), on: flag(a, 'on'), merge: optional(a, 'merge', flag) }) },
  // Matt, 2026-11-24: "please add the code review and tickets pages" (kestrel-connect.md, "The Code reviews and
  // Tickets pages on a phone"). Reads only: no action on a request or a ticket is on the list yet.
  'reviews.read': { mapsTo: 'the review-requests push (ReviewRequestStore.view)', fields: [], check: () => ({ ok: true, value: {} }) },
  'tickets.read': { mapsTo: 'the tickets push (TicketStore.view)', fields: [], check: () => ({ ok: true, value: {} }) },
  // Matt, 2026-11-24, on the pages' actions: "1. Yep, it's the same seen 2. Yes, agree 3. Yes, agree 4. Also agree
  // 5. Let's allow it to start a review / work a ticket." Each is the desk's button: the same call, the same refusals.
  // The two starts are A8's first use: this computer's switch, and never Bypass (kestrel-connect.md, "Actions").
  'reviews.seen': { mapsTo: 'PUT /api/review-requests/seen', fields: ['keys', 'seen'], check: (a) => all({ keys: recordKeys(a, 'keys'), seen: flag(a, 'seen') }) },
  'reviews.dismiss': { mapsTo: 'PUT /api/review-requests/dismissed', fields: ['keys', 'dismissed'], check: (a) => all({ keys: recordKeys(a, 'keys'), dismissed: flag(a, 'dismissed') }) },
  'reviews.start': { mapsTo: 'POST /api/review-requests/start (A8)', fields: ['key'], check: (a) => all({ key: recordKey(a, 'key') }) },
  'tickets.seen': { mapsTo: 'PUT /api/tickets/seen', fields: ['keys', 'seen'], check: (a) => all({ keys: recordKeys(a, 'keys'), seen: flag(a, 'seen') }) },
  'tickets.dismiss': { mapsTo: 'PUT /api/tickets/dismissed', fields: ['keys', 'dismissed'], check: (a) => all({ keys: recordKeys(a, 'keys'), dismissed: flag(a, 'dismissed') }) },
  'tickets.statuses': { mapsTo: 'GET /api/tickets/statuses', fields: ['key'], check: (a) => all({ key: recordKey(a, 'key') }) },
  'tickets.move': { mapsTo: 'POST /api/tickets/move (moveTicket)', fields: ['key', 'to'], check: (a) => all({ key: recordKey(a, 'key'), to: text(200)(a, 'to') }) },
  'tickets.comment': { mapsTo: 'POST /api/tickets/comment (commentOnTicket)', fields: ['key', 'body'], check: (a) => all({ key: recordKey(a, 'key'), body: text(MESSAGE_MAX)(a, 'body') }) },
  'tickets.detail': { mapsTo: 'POST /api/tickets/read', fields: ['key'], check: (a) => all({ key: recordKey(a, 'key') }) },
  'tickets.work': { mapsTo: 'POST /api/tickets/work (A8)', fields: ['key'], check: (a) => all({ key: recordKey(a, 'key') }) },
  // The day's desk changes on the phone (2026-11-24; kestrel-connect.md, "What a phone gets of the desk's changes").
  'pullRequests.read': { mapsTo: 'the pull-requests push (PullRequestStore.all) and Settings → Git’s choices', fields: [], check: () => ({ ok: true, value: {} }) },
  // A finding and the review-end card are in the chat window (Matt, 2026-11-22: "if it's in the chat window, the phone
  // can interact with it"); their buttons are routes of their own, so each op calls what its route calls.
  'findings.act': {
    mapsTo: 'POST /api/sessions/:id/findings',
    fields: ['sessionId', 'cardId', 'findingId', 'action', 'text'],
    check: (a) => all({ sessionId: id(a, 'sessionId'), cardId: id(a, 'cardId'), findingId: id(a, 'findingId'), action: oneOf(FINDING_ACTIONS)(a, 'action'), text: optional(a, 'text', text(ANSWER_MAX, true)) }),
  },
  'reviewEnd.act': {
    mapsTo: 'POST /api/sessions/:id/review-end',
    fields: ['sessionId', 'cardId', 'action', 'findingIds'],
    check: (a) => all({ sessionId: id(a, 'sessionId'), cardId: id(a, 'cardId'), action: oneOf(REVIEW_END_ACTIONS)(a, 'action'), findingIds: optional(a, 'findingIds', ids(FINDING_IDS_MAX)) }),
  },
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
  'session.rename': 'A session is renamed at the desk.',
  'session.move': 'A session is moved at the desk.',
  'session.archive': 'A session is archived at the desk.',
  'session.model': 'A session\'s model is changed at the desk.',
  'session.permission': 'A session\'s mode is changed at the desk.',
  pair: 'Devices are paired at a desk or an already-paired phone, never by a request.',
};

/** Bypass is never chosen from another device (A8). */
export const BYPASS_FROM_ELSEWHERE = 'Bypass is chosen on the computer the session runs on.';

/** Every op that names a sidebar's session is refused with this (kestrel-connect.md, "Sidebars"). */
export const ASIDE_REFUSAL = 'A sidebar is used beside its conversation at the desk.';

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
