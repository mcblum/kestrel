// Kestrel's own steps that wait on a card, stored so they survive a restart (shared/waiting-steps.ts;
// design doc, "Kestrel's own cards survive a restart").
//
// The call that raises a card runs inside a step context (`Delegation.guard` for a tool, `passOn` for
// a role's fallback): `requestApproval` stores the step from it before the card shows. Taking the step
// up after a restart makes the same call again inside a replay context, where the approval is answered
// by the stored choice once the card it would raise now is the same as the stored one.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Refused } from '../refused.ts';
import { ALREADY_TAKING, changedRefusal, sameCard, withStatus, type StepCall, type StepCard, type WaitingStep } from '../shared/waiting-steps.ts';
import type { Workspace } from '../workspace.ts';

/** A replay: the stored answer, given to the call's approval once, when it asks the same thing. */
export interface Replay {
  card: StepCard;
  approved: boolean;
  /** The call reached its approval again. */
  reached: boolean;
  /** It would have asked something else: why nothing was done. */
  changed: string | null;
}

interface StepContext {
  /** The session the call's card shows in. A card in another session (a child started from inside the call, which carries this context with it) is not this step's. */
  sessionId: string;
  /** The call being made, to store with a card it raises. Absent inside a replay's own bookkeeping. */
  call?: StepCall;
  /** Cards this call raised, by the session they show in: their steps end with the call. */
  raised: { sessionId: string; requestId: string }[];
  replay?: Replay;
}

const context = new AsyncLocalStorage<StepContext>();

/** Runs `work` as a call whose cards are stored as steps, inside an unfinished replay when there is one. Removes its steps when it ends. */
export async function asStep<T>(steps: WaitingSteps, sessionId: string, call: StepCall, work: () => Promise<T>): Promise<T> {
  const outer = context.getStore();
  const replay = outer?.replay && !outer.replay.reached && outer.sessionId === sessionId ? outer.replay : undefined;
  const ctx: StepContext = { sessionId, call, raised: [], ...(replay ? { replay } : {}) };
  try {
    return await context.run(ctx, work);
  } finally {
    for (const { sessionId, requestId } of ctx.raised) await steps.remove(sessionId, requestId);
  }
}

/** Runs `work` as the replay of a stored step. */
export const replaying = <T>(sessionId: string, replay: Replay, work: () => Promise<T>): Promise<T> => context.run({ sessionId, raised: [], replay }, work);

/** Whether the call running now is a replay that has not reached its approval yet: it must not skip the card. */
export const inReplay = (): boolean => {
  const replay = context.getStore()?.replay;
  return replay !== undefined && !replay.reached;
};

export class WaitingSteps {
  /** One write at a time per session, so a read-change-write never loses another's change. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Steps being carried out now, so a second answer is refused before the first is written. */
  private readonly taking = new Set<string>();

  constructor(
    private readonly workspace: Pick<Workspace, 'storedDetail' | 'setDetail'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The stored steps of a session. */
  async list(sessionId: string): Promise<readonly WaitingStep[]> {
    return (await this.workspace.storedDetail(sessionId))?.steps ?? [];
  }

  async find(sessionId: string, requestId: string): Promise<WaitingStep | null> {
    return (await this.list(sessionId)).find((s) => s.requestId === requestId) ?? null;
  }

  private change(sessionId: string, edit: (steps: readonly WaitingStep[]) => readonly WaitingStep[]): Promise<void> {
    const run = (this.chains.get(sessionId) ?? Promise.resolve()).then(async () => {
      const stored = await this.workspace.storedDetail(sessionId);
      if (!stored) return;
      const before = stored.steps ?? [];
      const after = edit(before);
      if (after !== before) await this.workspace.setDetail(sessionId, { steps: after });
    });
    const settled = run.catch(() => undefined);
    this.chains.set(sessionId, settled);
    void settled.then(() => this.chains.get(sessionId) === settled && this.chains.delete(sessionId));
    return run;
  }

  /**
   * Before a card shows: inside a step context, its step is stored first, so the card never exists
   * without the step that takes it up. Inside a replay, the stored answer instead, when the card is
   * the same; a card that is not the same refuses with what it would ask now. Null: ask as usual.
   */
  async beforeCard(sessionId: string, card: StepCard & { requestId: string }): Promise<boolean | null> {
    const ctx = context.getStore();
    if (!ctx || ctx.sessionId !== sessionId) return null;
    const replay = ctx.replay;
    if (replay && !replay.reached) {
      replay.reached = true;
      const now: StepCard = { tool: card.tool, title: card.title, detail: card.detail };
      if (!sameCard(now, replay.card)) {
        replay.changed = changedRefusal(now);
        throw new Refused(replay.changed);
      }
      return replay.approved;
    }
    if (!ctx.call) return null;
    const step: WaitingStep = { requestId: card.requestId, call: ctx.call, card: { tool: card.tool, title: card.title, detail: card.detail }, raisedAt: this.now(), status: 'waiting' };
    await this.change(sessionId, (steps) => [...steps.filter((s) => s.requestId !== step.requestId), step]);
    ctx.raised.push({ sessionId, requestId: card.requestId });
    return null;
  }

  /**
   * The answer is about to be carried out: the step is marked `taking`, and that is written first.
   * Refused when it is already being carried out. A card with no stored step is let through.
   */
  async take(sessionId: string, requestId: string): Promise<void> {
    const key = `${sessionId}/${requestId}`;
    if (this.taking.has(key)) throw new Refused(ALREADY_TAKING);
    this.taking.add(key);
    try {
      const step = await this.find(sessionId, requestId);
      if (step?.status === 'taking') throw new Refused(ALREADY_TAKING);
      if (step) await this.change(sessionId, (steps) => withStatus(steps, requestId, 'taking'));
    } catch (error) {
      this.taking.delete(key);
      throw error;
    }
  }

  /** The step is over (done, declined, refused): it is removed. */
  async remove(sessionId: string, requestId: string): Promise<void> {
    this.taking.delete(`${sessionId}/${requestId}`);
    await this.change(sessionId, (steps) => (steps.some((s) => s.requestId === requestId) ? steps.filter((s) => s.requestId !== requestId) : steps));
  }

  /** Every step of the session is over (Stop). */
  async clear(sessionId: string): Promise<void> {
    for (const key of [...this.taking]) if (key.startsWith(`${sessionId}/`)) this.taking.delete(key);
    await this.change(sessionId, (steps) => (steps.length ? [] : steps));
  }
}
