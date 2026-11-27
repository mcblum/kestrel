// The turn loop, the user's side: a message for the agent (`reply`), what is queued and sent as the
// next turn, a settings change between turns, an answered card, and Stop. A turn's end, the agent's
// side, is in `events.ts`. The order of side effects when a turn starts is what delegation and the
// queue tests rely on. Moved out of runtime.ts as it was (0.0.18).
import { randomUUID } from 'node:crypto';
import type { InputAnswer } from '../agents/types.ts';
import type { DraftRefs } from '../attachments/store.ts';
import { AGENT_LABEL, type Session, type SessionSettings } from '../model.ts';
import { afterTurn, enqueue, removeQueued, takeAll, type OutgoingPart } from '../shared/queue.ts';
import { anyRunning } from '../shared/subagents.ts';
import { RESTORED_NOTICE } from '../shared/workstreams.ts';
import { Refused } from '../workspace.ts';
import { ALREADY_TAKING, type WaitingStep } from '../shared/waiting-steps.ts';
import { reattach, restartUnstarted, type BringUpHost } from './bring-up.ts';
import { ACTIVITY, type RuntimeHost } from './host.ts';
import { deliverHeld, deliverNote, sendDuringTurn } from './mid-turn.ts';
import type { MessageFrom, NoteOutcome } from '../shared/notes.ts';
import { answersLabel, definedChange, isWorking, sameSettings, type Live } from './record.ts';

export type TurnHost = BringUpHost & Pick<RuntimeHost, 'background' | 'sandboxAllow' | 'midTurn' | 'emitLive' | 'setQueue' | 'sessionOrThrow' | 'recordFor' | 'steps'>;

/** What `reply` takes besides the text. */
export interface ReplyOptions {
  notice?: boolean;
  draft?: DraftRefs | null;
  /** Sent by another session (`ask_session`), not typed by the user. */
  fromAgent?: boolean;
  /** Which session sent it, and its own words (shared/notes.ts), kept with it while it is held. */
  from?: MessageFrom;
  /** Sent by Autopilot as a round (pull-requests/autopilot.ts): not the user taking over. */
  autopilot?: boolean;
}

/** The session and its live record, refused with the reason when it has no agent behind it. */
async function liveSession(host: TurnHost, sessionId: string): Promise<{ session: Session; rec: Live }> {
  const session = await host.sessionOrThrow(sessionId);
  const rec = await host.recordFor(session);
  if (!rec) throw new Refused(`"${session.title}" has no agent behind it (it is sample data, or it never started), so it cannot take a reply.`);
  return { session, rec };
}

/**
 * A message for the agent. One the user typed while a turn runs goes into that turn at once and is
 * 'delivered', or is held with why and 'queued' (runtime/mid-turn.ts); another session's waits for
 * the turn to end (shared/mid-turn.ts says why). Anything held goes along with the next turn sent.
 * A notice (news from another session, a summary ask) is never held: it is refused while busy.
 */
export async function reply(host: TurnHost, sessionId: string, text: string, change: Partial<SessionSettings>, opts: ReplyOptions): Promise<'sent' | 'delivered' | 'queued'> {
  const typedByUser = !opts.notice && !opts.fromAgent;
  if (typedByUser) host.delegation.onUserMessage(sessionId);
  const trimmed = text.trim();
  if (!trimmed && !opts.draft?.ids.length) throw new Refused('Write a message first.');
  const { session, rec } = await liveSession(host, sessionId);
  // A model, effort or fast mode the user changes here is theirs: Kestrel does not move the session off it.
  if (typedByUser && !sameSettings({ ...rec.settings, ...definedChange({ model: change.model, effort: change.effort, fast: change.fast }) }, rec.settings)) rec.modelChosen = true;
  // Continuing the conversation resumes the effort: a message the user typed brings an archived
  // workstream back to the sidebar, and makes a complete one active (shared/workstreams.ts).
  if (typedByUser && (await host.workspace.resumeWorkstreamOf(sessionId))) host.apply(sessionId, rec, { type: 'notice', id: `notice-${randomUUID()}`, text: RESTORED_NOTICE, level: 'info' });
  if (isWorking(rec)) {
    if (opts.notice) throw new Refused('The agent is still working. Wait for it to finish, or stop it first.');
    const attachments = host.attachments.claim(sessionId, opts.draft);
    // The user's own words go into the running turn; another session's wait for it to end.
    if (typedByUser) return sendDuringTurn(host.midTurn, sessionId, rec, { text: trimmed, change, changesSettings: !sameSettings({ ...rec.settings, ...definedChange(change) }, rec.settings), attachments });
    host.setQueue(sessionId, rec, enqueue(rec.queue, { id: `queued-${randomUUID()}`, text: trimmed, change, attachments, fromAgent: true, ...(opts.from ? { from: opts.from } : {}) }));
    return 'queued';
  }
  if (opts.notice) {
    await sendTurn(host, session, rec, [{ text: trimmed }], {}, true);
    return 'sent';
  }
  const all = takeAll(rec.queue, { text: trimmed, change, attachments: host.attachments.claim(sessionId, opts.draft), fromAgent: opts.fromAgent, from: opts.from });
  await sendTurn(host, session, rec, all.parts, all.change, false, all.byUser);
  host.setQueue(sessionId, rec, all.queue);
  return 'sent';
}

/**
 * A note from another session (shared/notes.ts; `text` is what the model gets). Into the running turn
 * when the agent can take it ('delivered'); held for that turn's end when it cannot ('turn-end'); held
 * for the next turn, whenever it comes, when the session is not working ('next-turn'). Never starts a turn.
 */
export async function note(host: TurnHost, sessionId: string, text: string, from: MessageFrom): Promise<NoteOutcome> {
  const { rec } = await liveSession(host, sessionId);
  const item = { id: `note-${randomUUID()}`, text, fromAgent: true as const, from };
  if (isWorking(rec)) {
    if (await deliverNote(host.midTurn, sessionId, rec, item)) return 'delivered';
    host.setQueue(sessionId, rec, enqueue(rec.queue, item));
    return 'turn-end';
  }
  // Waiting is all it does: a queue held after a stop stays held.
  host.setQueue(sessionId, rec, { ...enqueue(rec.queue, item), held: rec.queue.held });
  return 'next-turn';
}

/** Send what is queued now, as one turn: "Send now" after a stop, a failure or a restart. */
export async function sendQueued(host: TurnHost, sessionId: string): Promise<void> {
  const { session, rec } = await liveSession(host, sessionId);
  if (rec.queue.items.length === 0) throw new Refused('Nothing is queued.');
  if (isWorking(rec)) throw new Refused('The agent is still working. Queued messages go when this turn ends.');
  const all = takeAll(rec.queue);
  await sendTurn(host, session, rec, all.parts, all.change, false, all.byUser);
  host.setQueue(sessionId, rec, all.queue);
}

/** Drop one queued message before it is sent. */
export async function dropQueued(host: TurnHost, sessionId: string, messageId: string): Promise<void> {
  const { rec } = await liveSession(host, sessionId);
  const next = removeQueued(rec.queue, messageId);
  if (next === rec.queue) throw new Refused('That message is no longer queued: it was sent or removed already.');
  host.setQueue(sessionId, rec, next);
}

/** The turn ended normally with messages queued: they are the next turn. A failure leaves them held and says why. */
export async function flushQueue(host: TurnHost, id: string): Promise<void> {
  try {
    await sendQueued(host, id);
  } catch (error) {
    const rec = host.records.get(id);
    if (rec) host.setQueue(id, rec, afterTurn(rec.queue, 'failed'));
    host.notice(id, `Your queued messages were not sent: ${error instanceof Error ? error.message : String(error)} They are still queued.`, 'error');
  }
}

/** Start a turn on an idle session: the user's message(s), or a notice from Kestrel. `byUser`: the user wrote any of it. */
async function sendTurn(host: TurnHost, session: Session, rec: Live, parts: OutgoingPart[], change: Partial<SessionSettings>, notice: boolean, byUser = false): Promise<void> {
  const sessionId = session.id;
  rec.turnByUser = !notice && byUser;
  const text = parts.map((p) => p.text).filter(Boolean).join('\n\n');
  applySettings(host, session, rec, change);
  // Settings Kestrel changed while the last turn ran (`moveSettings`) take effect now.
  if (rec.rebuild) rebuild(host, session, rec);
  if (!notice && !rec.handle && rec.unstarted) return restartUnstarted(host, session, rec, parts);
  if (!rec.handle) rec.handle = await reattach(host, session, rec);
  await host.workspace.setState(sessionId, 'running', 'Working…', { ...ACTIVITY, byUser: rec.turnByUser });
  // News from other sessions that arrived while this one was busy goes along with the next turn.
  const news = notice ? '' : rec.inbox.splice(0).join('\n');
  if (notice) rec.inbox.splice(0);
  else rec.stopped = false;
  // Whose news this turn carries: a decision it leaves the user links back to them (display.ts `nextStep`).
  rec.turnNewsFrom = [...new Set(rec.newsFrom.splice(0))];
  rec.endedForUser = false;
  host.delegation.onSessionRunning(sessionId);
  if (notice) host.apply(sessionId, rec, { type: 'notice', id: `notice-${randomUUID()}`, text, level: 'info', startsTurn: true });
  else showUserParts(host, sessionId, rec, parts);
  rec.handle.send([news, text].filter(Boolean).join('\n\n'), host.attachments.forAgent(sessionId, parts.flatMap((p) => p.attachments ?? [])));
}

/** The words a compaction starts with: the line in the conversation and the session's status. */
export const COMPACTING = 'Compacting the conversation';

/**
 * Compact the conversation by the agent's own means, as a turn of its own (kestrel-connect.md, "The
 * context window, and Compact"): the window's Compact button and a phone's `session.compact` both come
 * here. Refused while the agent works, while a card waits on the user, before the conversation has
 * started, and for an agent that cannot.
 */
export async function compactTurn(host: TurnHost, sessionId: string): Promise<void> {
  const { session, rec } = await liveSession(host, sessionId);
  // A card first: a turn waiting on one is also working, and the card is what the user can act on.
  if (rec.pendingInput.size > 0) throw new Refused('This session is waiting on your answer to a card. Answer it first, then compact.');
  if (isWorking(rec)) throw new Refused('The agent is working. Compact once this turn ends, or stop it first.');
  if (!rec.agentSessionId) throw new Refused('This conversation has not started yet, so there is nothing to compact.');
  // Settings Kestrel changed while the last turn ran take effect now, as for any turn.
  if (rec.rebuild) rebuild(host, session, rec);
  if (!rec.handle) rec.handle = await reattach(host, session, rec);
  const handle = rec.handle;
  if (!handle.compact) throw new Refused(`${AGENT_LABEL[session.agent]} cannot compact a conversation from Kestrel.`);
  await host.workspace.setState(sessionId, 'running', `${COMPACTING}…`, ACTIVITY);
  rec.stopped = false;
  rec.turnByUser = true;
  rec.endedForUser = false;
  host.delegation.onSessionRunning(sessionId);
  host.apply(sessionId, rec, { type: 'notice', id: `notice-${randomUUID()}`, text: COMPACTING, level: 'info', startsTurn: true });
  handle.compact();
}

/** Messages that waited in the queue show as written, one bubble each; the agent gets one turn. */
function showUserParts(host: TurnHost, sessionId: string, rec: Live, parts: OutgoingPart[]): void {
  const ids = parts.map(() => `user-${randomUUID()}`);
  parts.forEach((part, i) => {
    const { from, ...shown } = part;
    if (from?.kind === 'note') host.apply(sessionId, rec, { type: 'note', id: ids[i]!, from });
    else host.apply(sessionId, rec, { type: 'user', id: ids[i]!, ...shown });
  });
  // Helpers still working move down under the user's new message; a finished list stays where it was.
  if (anyRunning(rec.subagents)) {
    rec.subagentsAfter = ids[0]!;
    host.emitLive(sessionId, { subagentsAfter: ids[0]! });
  } else rec.subagentsStale = true; // a finished card stays where it is; the next helper starts a new one
}

/** Model, effort, fast mode and permission can change between messages; the next turn is built with them. */
function applySettings(host: TurnHost, session: Session, rec: Live, change: Partial<SessionSettings>): void {
  const next: SessionSettings = { ...rec.settings, ...definedChange(change) };
  if (sameSettings(next, rec.settings)) return;
  rec.settings = next;
  rebuild(host, session, rec);
  host.emitLive(session.id, { settings: next });
  host.upkeep.schedulePersist(session.id, rec);
}

/**
 * Kestrel changes a session's model, effort or fast mode while its turn runs (a lead moving to the
 * Orchestrate preset): shown at once, and the agent is rebuilt with them before its next turn.
 */
export function moveSettings(host: TurnHost, sessionId: string, rec: Live, change: Partial<SessionSettings>): void {
  const next: SessionSettings = { ...rec.settings, ...definedChange(change) };
  if (sameSettings(next, rec.settings)) return;
  rec.settings = next;
  rec.rebuild = true;
  host.emitLive(sessionId, { settings: next });
  host.upkeep.schedulePersist(sessionId, rec);
}

/** The agent is started again from its own session id with the settings the record now holds. */
function rebuild(host: TurnHost, session: Session, rec: Live): void {
  rec.rebuild = false;
  // An agent that keeps a process ends it, and with it whatever that process still ran in the background.
  const ended = host.background.list(session.id).length;
  void rec.handle?.close?.().catch(() => undefined);
  rec.handle = null;
  rec.endedForUser = false;
  host.endRunning(session.id);
  if (ended > 0) host.notice(session.id, `The new settings restarted the agent, which stopped the ${ended === 1 ? 'work' : `${ended} pieces of work`} it had running in the background.`, 'warning');
}

/**
 * The answer to one of Kestrel's own cards once its turn is over. The session is put at rest first,
 * then the waiting tool call gets the choice: what it does next (a move, a review, the sessions it
 * starts) sets the session's state from there.
 */
async function answerAfterTurn(host: TurnHost, sessionId: string, rec: Live, requestId: string, label: string, own: (approved: boolean) => void, approved: boolean): Promise<void> {
  // Written first: a restart while this is carried out finds it `taking`, and never does it again.
  await host.steps.take(sessionId, requestId);
  rec.kestrelRequests.delete(requestId);
  rec.pendingInput.delete(requestId);
  host.apply(sessionId, rec, { type: 'resolved', requestId, label });
  if (rec.pendingInput.size === 0) await host.workspace.setState(sessionId, 'done', await host.delegation.doneNote(sessionId, rec.stopped === true), ACTIVITY);
  own(approved);
}

/**
 * One of Kestrel's own cards, raised before a restart and answered after it: nothing waits on it in
 * memory, so its stored step is taken up (`Delegation.resumeStep`), which makes the call again with
 * today's checks. The card closes with the choice, or with why nothing was done.
 */
async function answerStoredStep(host: TurnHost, sessionId: string, rec: Live, step: WaitingStep, label: string, approved: boolean): Promise<void> {
  const { requestId } = step;
  await host.steps.take(sessionId, requestId);
  try {
    const othersOpen = rec.messages.some((m) => m.input && !m.input.resolved && m.input.id !== requestId);
    if (!othersOpen) await host.workspace.setState(sessionId, 'done', await host.delegation.doneNote(sessionId, rec.stopped === true), ACTIVITY);
    let refusal: string | null;
    try {
      refusal = await host.delegation.resumeStep(sessionId, step, approved);
    } catch (error) {
      // It failed part way: the card says so rather than staying open with nothing behind it.
      refusal = error instanceof Error ? error.message : String(error);
      host.notice(sessionId, `Kestrel could not do what you approved: ${refusal}`, 'error');
    }
    rec.pendingInput.delete(requestId);
    rec.keptSteps.delete(requestId);
    host.apply(sessionId, rec, { type: 'resolved', requestId, label: refusal ? notDone(refusal) : label });
  } finally {
    await host.steps.remove(sessionId, requestId);
  }
}

/** The card's closing words when the answer could not be carried out after a restart. */
const notDone = (refusal: string): string => `Not done: ${refusal}`;

/** The user answered a card: the agent (or Kestrel's own waiting tool call) gets the choice. */
export async function answerCard(host: TurnHost, sessionId: string, requestId: string, answer: InputAnswer): Promise<void> {
  // After a restart the session may not be loaded yet: its record is brought up from the store.
  const rec = host.records.get(sessionId) ?? (await host.recordFor(await host.sessionOrThrow(sessionId))) ?? undefined;
  const waiting = rec?.kestrelRequests.get(requestId);
  const openCard = rec?.messages.find((m) => m.input?.id === requestId && !m.input.resolved)?.input;
  const stored = rec && !waiting && openCard?.kestrel ? await host.steps.find(sessionId, requestId) : null;
  if (rec && stored?.status === 'waiting') {
    const label = openCard?.options.find((o) => o.id === answer.optionId)?.label ?? answer.text ?? 'Answered';
    return answerStoredStep(host, sessionId, rec, stored, label, answer.optionId === 'allow');
  }
  if (stored?.status === 'taking') throw new Refused(ALREADY_TAKING);
  if (!rec || !rec.pendingInput.has(requestId) || (!rec.handle && !waiting)) throw new Refused('Nothing is waiting for an answer there any more.');
  const card = rec.messages.find((m) => m.input?.id === requestId)?.input;
  const label = answer.answers ? answersLabel(answer.answers) : (card?.options.find((o) => o.id === answer.optionId)?.label ?? answer.text ?? 'Answered');
  const own = waiting;
  // One of Kestrel's own cards, answered after the turn it was raised in ended (events.ts keeps it
  // open): no turn is running, so the session is at rest until what was approved starts something.
  if (own && !rec.handle?.busy() && !rec.launching) return answerAfterTurn(host, sessionId, rec, requestId, label, own, answer.optionId === 'allow');
  // An "Always allow" choice on a sandbox card puts the card's own offer on the list first.
  // `confirmed` is Kestrel's (a choice that asks first), never the agent's.
  const { confirmed: _confirmed, ...forwarded } = own ? answer : await host.sandboxAllow.answerCard(card, answer);
  if (own) {
    // Kestrel's own card (delegate, spawn): the waiting tool call gets the choice, once the step is written as being carried out.
    await host.steps.take(sessionId, requestId);
    rec.kestrelRequests.delete(requestId);
    own(answer.optionId === 'allow');
  } else rec.handle!.answer(requestId, forwarded); // not one of Kestrel's own, so there is a handle (checked above)
  rec.pendingInput.delete(requestId);
  host.apply(sessionId, rec, { type: 'resolved', requestId, label });
  if (rec.pendingInput.size > 0) return;
  await host.workspace.setState(sessionId, 'running', 'Working…', ACTIVITY);
  // What the user wrote while the card waited goes into the turn now.
  await deliverHeld(host.midTurn, sessionId, rec);
}

/**
 * Stop asked of a session with nothing running. One that still reads as at work (it failed, or its
 * agent went away while it waited) is settled as stopped: the menu offers Stop for it and holds
 * Archive and Delete back, so refusing left no way to put it away (Matt, 2026-11-23). Any other
 * session is refused, as before.
 */
async function settleIdle(host: TurnHost, sessionId: string, rec: Live | undefined): Promise<void> {
  const session = (await host.workspace.state()).sessions.find((s) => s.id === sessionId);
  if (session?.state !== 'running' && session?.state !== 'attention') throw new Refused('This session is not running.');
  // Kestrel's own cards kept over a restart are declined too: their steps end, and the record is brought up to close them.
  await host.steps.clear(sessionId);
  rec ??= (await host.recordFor(session)) ?? undefined;
  if (rec) {
    rec.stopped = true;
    rec.keptSteps.clear();
    // Kestrel's own cards left open by the turn that ended: declined, and closed.
    for (const [requestId, resolve] of rec.kestrelRequests) {
      rec.kestrelRequests.delete(requestId);
      resolve(false);
    }
    host.apply(sessionId, rec, { type: 'settled' });
    rec.pendingInput.clear();
    host.setQueue(sessionId, rec, afterTurn(rec.queue, 'stopped'));
  }
  await host.workspace.setState(sessionId, 'done', await host.delegation.doneNote(sessionId, true), { ...ACTIVITY, stopped: true });
}

/** Stop a running turn, or abandon a start still deciding its title or making its worktree. */
export async function stopTurn(host: TurnHost, sessionId: string): Promise<void> {
  const rec = host.records.get(sessionId);
  const starting = !!rec?.launching && !rec.handle;
  if (!rec || (!starting && !rec.handle?.busy())) return settleIdle(host, sessionId, rec);
  rec.stopped = true;
  // Whatever was queued waits for the user instead of going by itself.
  host.setQueue(sessionId, rec, afterTurn(rec.queue, 'stopped'));
  if (starting) {
    // Still deciding its title or making its worktree: abandon the start (bringUp ends it as stopped).
    rec.launchAbort?.abort();
    await rec.launching;
    return void (await rec.chain);
  }
  if (!rec.handle) return;
  for (const [requestId, resolve] of rec.kestrelRequests) {
    rec.kestrelRequests.delete(requestId);
    resolve(false);
  }
  await rec.handle.stop();
  host.endRunning(sessionId);
}
