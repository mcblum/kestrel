// What the user does with the card that stays when the review of a session's own work ended with
// findings still open (shared/round-findings.ts `ReviewEnd`, Matt 2026-11-24): ask the author to fix
// the findings they chose, in one message, or carry on (the card leaves the foot of the conversation;
// Undo brings it back). Dismissing one finding, answering its question and starting a sidebar about
// it are a finding's own actions on its round's card (finding-actions.ts, asides.ts): the card reads
// its findings from there, so there is one copy. Nothing here blocks: findings warn, never block.
import type { ChatMessage, SessionState } from './model.ts';
import { fixAllMessage, openFindings, REVIEW_END_NOTE, type ReviewEnd } from './shared/round-findings.ts';
import type { TranscriptAction } from './transcript.ts';
import { Refused } from './workspace.ts';

type Card = Extract<TranscriptAction, { type: 'card' }>;

export const REVIEW_END_ACTIONS = ['fix', 'close', 'reopen'] as const;
export type ReviewEndAction = (typeof REVIEW_END_ACTIONS)[number];
export const isReviewEndAction = (v: unknown): v is ReviewEndAction => REVIEW_END_ACTIONS.includes(v as ReviewEndAction);

export interface ReviewEndHost {
  messages(sessionId: string): readonly ChatMessage[];
  showCard(sessionId: string, card: Card): void;
  /** Send a message to the session as the user's own. Throws `Refused` with the reason. */
  send(sessionId: string, text: string): Promise<unknown>;
  /** The session's state and status line now. */
  stateOf(sessionId: string): Promise<{ state: SessionState; note?: string } | null>;
  /** The card no longer needs the user: the session reads as finished. */
  settle(sessionId: string): Promise<void>;
}

export class ReviewEndActions {
  private readonly sending = new Set<string>();

  constructor(private readonly host: ReviewEndHost) {}

  /** Do `action` to the review-end card `cardId`; resolves with the card as it now is. Throws `Refused` with the reason. */
  async act(sessionId: string, cardId: string, action: ReviewEndAction, findingIds: readonly string[] = []): Promise<ReviewEnd> {
    const end = this.endOf(sessionId, cardId);
    if (action === 'fix') return this.fix(sessionId, cardId, end, findingIds);
    const next: ReviewEnd = { ...end, state: action === 'close' ? 'closed' : 'open' };
    this.put(sessionId, cardId, next);
    // Carrying on is the user acting on what they were told to look at: the session no longer needs them for it.
    const now = action === 'close' ? await this.host.stateOf(sessionId) : null;
    if (now?.state === 'attention' && now.note === REVIEW_END_NOTE) await this.host.settle(sessionId);
    return next;
  }

  private endOf(sessionId: string, cardId: string): ReviewEnd {
    const end = this.host.messages(sessionId).find((m) => m.id === cardId)?.reviewEnd;
    if (!end) throw new Refused('There is no such review card in this session.');
    return end;
  }

  private put(sessionId: string, cardId: string, end: ReviewEnd): void {
    const message = this.host.messages(sessionId).find((m) => m.id === cardId);
    this.host.showCard(sessionId, { type: 'card', id: cardId, reviewEnd: end, ...(message?.at !== undefined ? { at: message.at } : {}) });
  }

  /** One message to the author asking for the chosen findings to be fixed; each is marked on its round's card. */
  private async fix(sessionId: string, cardId: string, end: ReviewEnd, ids: readonly string[]): Promise<ReviewEnd> {
    if (ids.length === 0) throw new Refused('Choose the findings to be fixed first.');
    const messages = this.host.messages(sessionId);
    const { findings, numberOf } = openFindings(messages, end);
    const chosen = ids.map((id) => findings.find((f) => f.id === id));
    if (chosen.some((f) => !f)) throw new Refused('One of those findings is not open on this card any more: it was dismissed, or the card changed.');
    const asking = chosen.filter((f) => !f!.fixAsked).map((f) => ({ finding: f!, number: numberOf.get(f!.id) }));
    if (asking.length === 0) throw new Refused('A fix was asked for already for each of those.');
    if (this.sending.has(cardId)) throw new Refused('That is being sent.');
    this.sending.add(cardId);
    try {
      await this.host.send(sessionId, fixAllMessage(asking, end.reviewer));
    } finally {
      this.sending.delete(cardId);
    }
    // Read again after sending: the round's card may have changed while the message went.
    const round = end.card ? this.host.messages(sessionId).find((m) => m.id === end.card) : undefined;
    if (round?.roundFindings && end.card) {
      const marked = new Set(asking.map((a) => a.finding.id));
      const roundFindings = { ...round.roundFindings, findings: round.roundFindings.findings.map((f) => (marked.has(f.id) ? { ...f, fixAsked: true } : f)) };
      this.host.showCard(sessionId, { type: 'card', id: end.card, roundFindings, ...(round.at !== undefined ? { at: round.at } : {}) });
    }
    return this.endOf(sessionId, cardId);
  }
}
