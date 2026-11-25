// The user's messages written while the agent works (shared/mid-turn.ts has the rules and words).
// Each goes to the agent at once through the adapter's `sendNow` (Claude: its streaming input;
// Codex: `turn/steer`; OpenCode: another `promptAsync`) and shows in the conversation as sent; the agent's `picked-up` marks it read.
// The few it cannot take then (a card waits, a settings change, a slash command, the agent refused)
// are held in the session's queue (shared/queue.ts) with why, and tried again when a card is
// answered, or sent as the next turn. One the agent took but never read before its run ended
// (`unread`) is taken back out of the conversation and held again, so it is neither lost nor sent twice.
import { randomUUID } from 'node:crypto';
import type { AgentAttachment, MidTurnMessage } from '../agents/types.ts';
import type { Attachment } from '../shared/attachments.ts';
import type { LivePatch } from '../model.ts';
import { holdWhy, isSlashCommand, retriesMidTurn } from '../shared/mid-turn.ts';
import { enqueue, hasUserMessages, removeQueued, requeueFront, takeLeading, type QueuedChange, type QueuedMessage, type SessionQueue } from '../shared/queue.ts';
import type { TranscriptAction } from '../transcript.ts';
import type { Live } from './record.ts';

/** What this needs from the runtime. */
export interface MidTurnHost {
  apply(sessionId: string, rec: Live, action: TranscriptAction): void;
  emitLive(sessionId: string, patch: LivePatch): void;
  setQueue(sessionId: string, rec: Live, queue: SessionQueue): void;
  /** The session's stored files as the agent gets them. */
  forAgent(sessionId: string, attachments: readonly Attachment[] | undefined): AgentAttachment[];
}

/** A message the user wrote while a turn runs. */
export interface DuringTurn {
  text: string;
  change: QueuedChange;
  /** The change differs from the session's settings, so only a new turn can take it. */
  changesSettings: boolean;
  attachments: readonly Attachment[];
}

/** Whether the agent can be handed a message now: it takes them mid-turn and is in a turn. */
const canTake = (rec: Live): boolean => rec.launching === null && typeof rec.handle?.sendNow === 'function' && rec.handle.busy();

/**
 * A message the user wrote while the agent works: sent into its turn ('delivered'), or held with why
 * ('queued'). Only for what the user typed: another session's messages wait for the turn to end.
 */
export async function sendDuringTurn(host: MidTurnHost, sessionId: string, rec: Live, msg: DuringTurn): Promise<'delivered' | 'queued'> {
  const why = holdWhy({ cardPending: rec.pendingInput.size > 0, changesSettings: msg.changesSettings, slashCommand: isSlashCommand(msg.text), heldBefore: hasUserMessages(rec.queue), canTake: canTake(rec) });
  const item: QueuedMessage = { id: `user-${randomUUID()}`, text: msg.text, ...(msg.changesSettings ? { change: msg.change } : {}), ...(msg.attachments.length ? { attachments: msg.attachments } : {}) };
  if (!why && (await deliver(host, sessionId, rec, item))) return 'delivered';
  host.setQueue(sessionId, rec, enqueue(rec.queue, { ...item, why: why ?? 'busy' }));
  return 'queued';
}

/** Hands one message to the agent's running turn; on success it shows in the conversation as sent. */
async function deliver(host: MidTurnHost, sessionId: string, rec: Live, item: QueuedMessage): Promise<boolean> {
  const handle = rec.handle;
  if (!handle?.sendNow) return false;
  const message: MidTurnMessage = { id: item.id, text: item.text, ...(item.attachments?.length ? { attachments: host.forAgent(sessionId, item.attachments) } : {}) };
  const taken = await handle.sendNow(message).catch(() => false);
  if (!taken) return false;
  rec.midTurn = [...rec.midTurn, item];
  if (item.from?.kind === 'note') host.apply(sessionId, rec, { type: 'note', id: item.id, from: item.from, midTurn: true });
  else host.apply(sessionId, rec, { type: 'user', id: item.id, text: item.text, ...(item.attachments?.length ? { attachments: item.attachments } : {}), midTurn: true });
  return true;
}

/**
 * A note from another session (shared/notes.ts) into the running turn, whatever waits on the user:
 * it asks nothing of them and changes no setting. False when the agent cannot take it now.
 */
export async function deliverNote(host: MidTurnHost, sessionId: string, rec: Live, item: QueuedMessage): Promise<boolean> {
  return canTake(rec) && deliver(host, sessionId, rec, item);
}

/**
 * A card was answered and nothing else waits on the user: the messages held behind it (and any the
 * agent could not take before) go into the turn now, in order, until one cannot.
 */
export async function deliverHeld(host: MidTurnHost, sessionId: string, rec: Live): Promise<void> {
  // One at a time, each left in the queue until the agent has it, so a message written meanwhile
  // lines up behind it and the order holds.
  for (;;) {
    if (rec.pendingInput.size > 0 || !canTake(rec)) return;
    const next = takeLeading(rec.queue, mayRetry).items[0];
    if (!next) return;
    // Refused now (the turn is ending): it waits for the turn to end, and says so.
    if (!(await deliver(host, sessionId, rec, next))) return host.setQueue(sessionId, rec, { ...rec.queue, items: rec.queue.items.map((m) => (m.id === next.id ? { ...m, why: 'busy' as const } : m)) });
    host.setQueue(sessionId, rec, removeQueued(rec.queue, next.id));
  }
}

/** A held message that may go into the running turn once nothing stands in its way. */
const mayRetry = (m: QueuedMessage): boolean => retriesMidTurn(m.why) && !m.change && !isSlashCommand(m.text);

/** The agent read these messages: they say so. */
export function pickedUp(host: MidTurnHost, sessionId: string, rec: Live, ids: readonly string[]): void {
  const read = new Set(ids);
  rec.midTurn = rec.midTurn.filter((m) => !read.has(m.id));
  host.apply(sessionId, rec, { type: 'picked-up', ids: [...ids] });
}

/**
 * The run ends without the agent having read these: they come back out of the conversation and are
 * held in front of whatever waits, in their order, to go as the next turn (or, after a stop or a
 * failure, when the user says). The run's own end follows and decides which (`afterTurn`).
 */
export function unread(host: MidTurnHost, sessionId: string, rec: Live, ids: readonly string[]): void {
  const back = new Set(ids);
  const items = rec.midTurn.filter((m) => back.has(m.id)).map((m) => ({ ...m, why: 'unread' as const }));
  rec.midTurn = rec.midTurn.filter((m) => !back.has(m.id));
  if (items.length === 0) return;
  const gone = items.map((m) => m.id);
  host.apply(sessionId, rec, { type: 'withdrawn', ids: gone });
  host.emitLive(sessionId, { removedMessages: gone });
  host.setQueue(sessionId, rec, requeueFront(rec.queue, items, false));
}

/** The run ended: what is still unacknowledged stays as sent (the agent cannot say whether it read it). */
export function runEnded(rec: Live): void {
  rec.midTurn = [];
}
