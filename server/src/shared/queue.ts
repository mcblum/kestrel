// Messages held for the agent's next turn. Pure: every function returns a new queue.
//
// Since 0.0.18 a message the user types while the agent works goes to it at once, within the turn
// (shared/mid-turn.ts); only the few it cannot take then wait here, each with why (`why`). What
// another session sends (`ask_session`) always waits here for the turn to end.
//
// The rules (design doc, "A message while the agent works"):
// - Messages wait in the order written. When the running turn ends normally, all of them go as
//   one next turn, joined by a blank line, the way Claude Code sends what was typed meanwhile.
// - A stopped or failed turn holds the queue: nothing is sent by itself. The user sends it (with
//   the composer or "Send now") or removes what they no longer want.
// - Writing again while a turn runs re-arms a held queue: the user is clearly still queueing.
// - A model, effort, fast-mode or permission change made with a queued message goes with the turn that carries it;
//   later changes win over earlier ones.
import type { Attachment } from './attachments.ts';
import type { PermissionLevel } from './permissions.ts';
import type { HoldWhy } from './mid-turn.ts';
import type { MessageFrom } from './notes.ts';

export interface QueuedChange {
  model?: string;
  permission?: PermissionLevel;
  effort?: string;
  fast?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  /** A model or permission change chosen in the composer when this was queued. */
  change?: QueuedChange;
  /** Files attached to it, already stored with the session. A message may be files alone. */
  attachments?: readonly Attachment[];
  /** Sent by another session (`ask_session`, `send_note`), not written by the user. */
  fromAgent?: true;
  /** Which session sent it, its own words and whether it is work or a note (shared/notes.ts). Absent on the user's messages and on older stored queues. */
  from?: MessageFrom;
  /** Why the user's message is held rather than gone to the agent (shared/mid-turn.ts). Absent on older stored queues. */
  why?: HoldWhy;
}

export interface SessionQueue {
  items: readonly QueuedMessage[];
  /** The turn was stopped or failed: wait for the user instead of sending by itself. */
  held: boolean;
}

export const EMPTY_QUEUE: SessionQueue = { items: [], held: false };

/** How a turn ended, as far as the queue cares. */
export type TurnEnd = 'complete' | 'stopped' | 'failed';

/** Only the fields that are set, so an empty change stays absent. */
function cleanChange(change: QueuedChange | undefined): QueuedChange | undefined {
  if (!change) return undefined;
  const out: QueuedChange = {};
  if (change.model !== undefined) out.model = change.model;
  if (change.permission !== undefined) out.permission = change.permission;
  if (change.effort !== undefined) out.effort = change.effort;
  if (change.fast !== undefined) out.fast = change.fast;
  return Object.keys(out).length ? out : undefined;
}

/** One message as it goes to the agent: its text and its files. */
export interface OutgoingPart {
  text: string;
  attachments?: readonly Attachment[];
  /** Another session sent it: a note shows as its quiet line, not as a message of the user's. */
  from?: MessageFrom;
  /** Not typed by the user (another session's work, or Kestrel's own words): shown as a preview when long (shared/message-preview.ts). */
  byAgent?: true;
}

const hasFiles = (m: { attachments?: readonly Attachment[] }) => (m.attachments?.length ?? 0) > 0;

export function enqueue(queue: SessionQueue, item: QueuedMessage): SessionQueue {
  const text = item.text.trim();
  if (!text && !hasFiles(item)) return queue;
  const change = cleanChange(item.change);
  const queued: QueuedMessage = { id: item.id, text, ...(change ? { change } : {}), ...(hasFiles(item) ? { attachments: item.attachments } : {}), ...(item.fromAgent ? { fromAgent: true as const } : {}), ...(item.from ? { from: item.from } : {}), ...(item.why ? { why: item.why } : {}) };
  return { items: [...queue.items, queued], held: false };
}

/**
 * Messages put back in front of what waits, in their order: they went into a turn that ended before
 * the agent read them. `held`: that turn was stopped or failed, so they wait for the user.
 */
export function requeueFront(queue: SessionQueue, items: readonly QueuedMessage[], held: boolean): SessionQueue {
  if (items.length === 0) return queue;
  return { items: [...items, ...queue.items], held: held || queue.held };
}

/**
 * The user's messages at the front that may still go into the running turn (`deliverable`: why they
 * wait may clear mid-turn), and the queue without them. Another session's messages are passed over
 * (they wait for the turn to end either way); the first of the user's that may not go stops it, so
 * the user's order is kept.
 */
export function takeLeading(queue: SessionQueue, deliverable: (m: QueuedMessage) => boolean): { items: QueuedMessage[]; queue: SessionQueue } {
  if (queue.held) return { items: [], queue };
  const mine = queue.items.filter((m) => !m.fromAgent);
  const stop = mine.findIndex((m) => !deliverable(m));
  const items = stop < 0 ? mine : mine.slice(0, stop);
  if (items.length === 0) return { items: [], queue };
  const taken = new Set(items);
  return { items, queue: { items: queue.items.filter((m) => !taken.has(m)), held: false } };
}

/** The user wrote at least one of the messages waiting (the rest came from other sessions). */
export const hasUserMessages = (queue: SessionQueue): boolean => queue.items.some((m) => !m.fromAgent);

/** Without the message with this id. The same queue when there is no such message. */
export function removeQueued(queue: SessionQueue, id: string): SessionQueue {
  if (!queue.items.some((m) => m.id === id)) return queue;
  const items = queue.items.filter((m) => m.id !== id);
  return { items, held: items.length > 0 && queue.held };
}

/** The turn ended: hold the queue unless it ended normally. */
export function afterTurn(queue: SessionQueue, end: TurnEnd): SessionQueue {
  if (end === 'complete' || queue.items.length === 0 || queue.held) return queue;
  return { ...queue, held: true };
}

/** Whether a turn that just ended should send the queue by itself. */
export function shouldFlush(queue: SessionQueue, end: TurnEnd): boolean {
  return end === 'complete' && !queue.held && queue.items.length > 0;
}

/**
 * Everything queued (and, optionally, the message being sent now, last) as one turn: the texts
 * joined by a blank line, the files of each in order, and the settings changes merged in order.
 * `parts` keeps each message apart, to show one bubble each. `byUser`: the user wrote at least one
 * of them (the rest came from other sessions). Returns the empty queue to keep.
 */
export function takeAll(
  queue: SessionQueue,
  now?: { text: string; change?: QueuedChange; attachments?: readonly Attachment[]; fromAgent?: boolean; from?: MessageFrom },
): { text: string; parts: OutgoingPart[]; attachments: Attachment[]; change: QueuedChange; queue: SessionQueue; byUser: boolean } {
  const current = now && (now.text.trim() || hasFiles(now)) ? [{ text: now.text.trim(), change: now.change, attachments: now.attachments, fromAgent: now.fromAgent, from: now.from }] : [];
  const all = [...queue.items, ...current];
  const change = all.reduce<QueuedChange>((acc, m) => ({ ...acc, ...cleanChange(m.change) }), {});
  const parts = all.map((m): OutgoingPart => ({ text: m.text, ...(hasFiles(m) ? { attachments: m.attachments } : {}), ...(m.from ? { from: m.from } : {}), ...(m.fromAgent ? { byAgent: true as const } : {}) }));
  const text = parts.map((p) => p.text).filter(Boolean).join('\n\n');
  return { text, parts, attachments: parts.flatMap((p) => p.attachments ?? []), change, queue: EMPTY_QUEUE, byUser: all.some((m) => !m.fromAgent) };
}
