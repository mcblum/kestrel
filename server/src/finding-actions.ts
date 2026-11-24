// What the user does to one finding on a card in a conversation (2026-11-24): answer the reviewer's
// question about it, ask the session to fix it, dismiss it or take it back. Both reviews' cards go
// through here (shared/findings.ts is the one shape): a pull-request review's card (`review`) and a
// rounds review's (`roundFindings`). Nothing here blocks or waits: the card never stops the
// conversation, and a finding can be acted on at any time, a sidebar about it open or not.
//
// What is sent goes to the session the card is in, as the user's own message (the user clicked it):
// the reviewing agent for a pull-request review, the author for a rounds review. A pull-request
// review's findings are edited and dismissed on the card's own draft before posting
// (review-requests/reply.ts), so only answering goes through here for it.
import type { ChatMessage } from './model.ts';
import { ANSWER_MAX, numberedFindings, type Finding } from './shared/findings.ts';
import { answerMessage, fixMessage } from './shared/round-findings.ts';
import type { TranscriptAction } from './transcript.ts';
import { Refused } from './workspace.ts';

type Card = Extract<TranscriptAction, { type: 'card' }>;

import { FINDING_ACTIONS, type FindingAction } from './shared/findings.ts';

export { FINDING_ACTIONS, type FindingAction };
export const isFindingAction = (v: unknown): v is FindingAction => FINDING_ACTIONS.includes(v as FindingAction);

export interface FindingActionsHost {
  /** The messages of a session's conversation, as they are now. */
  messages(sessionId: string): readonly ChatMessage[];
  showCard(sessionId: string, card: Card): void;
  /** Send a message to the session as the user's own. Throws `Refused` with the reason. */
  send(sessionId: string, text: string): Promise<unknown>;
}

/** A card with findings, and how to put it back with changed findings. */
interface FindingsCard {
  findings: readonly Finding[];
  kind: 'review' | 'rounds';
  reviewer: string;
  with(findings: Finding[]): Card;
}

function cardOf(message: ChatMessage | undefined): FindingsCard | null {
  const id = message?.id;
  if (!id) return null;
  if (message.review) {
    const review = message.review;
    return { findings: review.findings ?? [], kind: 'review', reviewer: 'the reviewer', with: (findings) => ({ type: 'card', id, review: { ...review, findings }, ...(message.at !== undefined ? { at: message.at } : {}) }) };
  }
  if (message.roundFindings) {
    const round = message.roundFindings;
    return { findings: round.findings, kind: 'rounds', reviewer: round.reviewer, with: (findings) => ({ type: 'card', id, roundFindings: { ...round, findings }, ...(message.at !== undefined ? { at: message.at } : {}) }) };
  }
  return null;
}

/** The finding a sidebar or an action names, with its number on the card; throws the reason when there is none. */
export function findingOn(messages: readonly ChatMessage[], cardId: string, findingId: string): { finding: Finding; number: number | undefined; kind: 'review' | 'rounds' } {
  const card = cardOf(messages.find((m) => m.id === cardId));
  if (!card) throw new Refused('There is no such review card in this session.');
  const finding = card.findings.find((f) => f.id === findingId);
  if (!finding) throw new Refused('That card has no such finding.');
  return { finding, number: numberedFindings(card.findings, card.kind === 'rounds').numberOf.get(findingId), kind: card.kind };
}

/** A finding without fields left undefined by a merge. */
const clean = (f: Finding): Finding => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as unknown as Finding;

export class FindingActions {
  /** Findings with a message on its way, so a second click cannot send it twice. */
  private readonly sending = new Set<string>();

  constructor(private readonly host: FindingActionsHost) {}

  /** Do `action` to one finding of a card; resolves with the finding as it now is. Throws `Refused` with the reason. */
  async act(sessionId: string, cardId: string, findingId: string, action: FindingAction, text = ''): Promise<Finding> {
    const card = cardOf(this.host.messages(sessionId).find((m) => m.id === cardId));
    if (!card) throw new Refused('There is no such review card in this session.');
    const finding = card.findings.find((f) => f.id === findingId);
    if (!finding) throw new Refused('That card has no such finding.');
    const number = numberedFindings(card.findings, card.kind === 'rounds').numberOf.get(findingId);
    const next = await this.changed(sessionId, card, finding, number, action, text);
    // Read again after sending: the card may have changed while the message went.
    const now = cardOf(this.host.messages(sessionId).find((m) => m.id === cardId)) ?? card;
    this.host.showCard(sessionId, now.with(now.findings.map((f) => (f.id === findingId ? { ...f, ...next, ...(action === 'restore' ? { dismissed: undefined } : {}) } : f)).map(clean)));
    return next;
  }

  private async changed(sessionId: string, card: FindingsCard, finding: Finding, number: number | undefined, action: FindingAction, text: string): Promise<Finding> {
    if (action === 'answer') {
      if (!finding.question) throw new Refused('This finding asks no question.');
      if (finding.answer) throw new Refused('This question was answered already.');
      const answer = text.trim();
      if (!answer) throw new Refused('Write an answer first.');
      if (answer.length > ANSWER_MAX) throw new Refused(`An answer can be at most ${ANSWER_MAX} characters.`);
      await this.once(sessionId, finding.id, () => this.host.send(sessionId, answerMessage(finding, number, answer)));
      return { ...finding, answer };
    }
    if (card.kind === 'review') throw new Refused('Change this review\'s findings on the card itself, before posting it.');
    if (action === 'fix') {
      if (finding.dismissed) throw new Refused('This finding was dismissed. Take it back first.');
      if (finding.fixAsked) throw new Refused('A fix was asked for already.');
      await this.once(sessionId, finding.id, () => this.host.send(sessionId, fixMessage(finding, number, card.reviewer)));
      return { ...finding, fixAsked: true };
    }
    if (action === 'dismiss') return { ...finding, dismissed: true };
    const { dismissed: _dropped, ...kept } = finding;
    return kept;
  }

  private async once(sessionId: string, findingId: string, work: () => Promise<unknown>): Promise<void> {
    const key = `${sessionId}:${findingId}`;
    if (this.sending.has(key)) throw new Refused('That is being sent.');
    this.sending.add(key);
    try {
      await work();
    } finally {
      this.sending.delete(key);
    }
  }
}
