// What a session may propose to change on its ticket (docs/designs/tickets.md, section 7), and the
// standing answers the user gave: per kind of change and per source, kept in the suggestion prefs and
// listed in Settings → Tickets, where each can be set back to Ask. Pure and shared with the UI.
//
// Only these three changes exist. Nothing moves a ticket to done, reassigns it or edits it.
import { sourceIdOf, TICKET_SOURCE_IDS, TICKET_SOURCE_LABEL, type TicketCategory, type TicketSourceId } from './tickets.ts';

export type TicketChange = 'in-progress' | 'in-review' | 'comment';
export const TICKET_CHANGES: readonly TicketChange[] = ['in-progress', 'in-review', 'comment'];
export const TICKET_CHANGE_LABEL: Record<TicketChange, string> = { 'in-progress': 'Move to In progress', 'in-review': 'Move to In review', comment: 'Add a comment' };

/** "Allow always" or "Don't ask again"; Ask is the absence of either. */
export type StandingAnswer = 'always' | 'never';

/** A tracker the answers are kept for: one of the sources, or the sample tracker of the demo. */
export type AnswerSource = TicketSourceId | 'sample';
export const ANSWER_SOURCES: readonly AnswerSource[] = [...TICKET_SOURCE_IDS, 'sample'];
export const ANSWER_SOURCE_LABEL: Record<AnswerSource, string> = { ...TICKET_SOURCE_LABEL, sample: 'Sample tracker' };

/** The answer source of a ticket's source kind (`gitlab@host`, `fake`). */
export const answerSourceOf = (sourceKind: string): AnswerSource => sourceIdOf(sourceKind) ?? 'sample';

export interface TicketAnswer {
  change: TicketChange;
  source: AnswerSource;
  answer: StandingAnswer;
}

/** The longest comment a session may propose. */
export const MAX_TICKET_COMMENT = 4000;

export const isTicketChange = (raw: unknown): raw is TicketChange => (TICKET_CHANGES as readonly unknown[]).includes(raw);

/** The stored answers, as far as they can be read: one per change and source, in a stable order. */
export function asTicketAnswers(raw: unknown): TicketAnswer[] {
  if (!Array.isArray(raw)) return [];
  const kept = new Map<string, TicketAnswer>();
  for (const a of raw as Partial<TicketAnswer>[]) {
    if (!a || !isTicketChange(a.change) || !(ANSWER_SOURCES as readonly unknown[]).includes(a.source) || (a.answer !== 'always' && a.answer !== 'never')) continue;
    kept.set(`${a.change}:${a.source}`, { change: a.change, source: a.source as AnswerSource, answer: a.answer });
  }
  return orderAnswers([...kept.values()]);
}

const orderAnswers = (answers: TicketAnswer[]): TicketAnswer[] =>
  [...answers].sort((a, b) => ANSWER_SOURCES.indexOf(a.source) - ANSWER_SOURCES.indexOf(b.source) || TICKET_CHANGES.indexOf(a.change) - TICKET_CHANGES.indexOf(b.change));

/** The standing answer for this change on a ticket of this source kind (`gitlab@host`, `jira`); null is Ask. */
export function standingAnswer(answers: readonly TicketAnswer[], change: TicketChange, sourceKind: string): StandingAnswer | null {
  const source = answerSourceOf(sourceKind);
  return answers.find((a) => a.change === change && a.source === source)?.answer ?? null;
}

/** The answers with this one set; null sets it back to Ask. */
export function withTicketAnswer(answers: readonly TicketAnswer[], change: TicketChange, source: AnswerSource, answer: StandingAnswer | null): TicketAnswer[] {
  const rest = answers.filter((a) => !(a.change === change && a.source === source));
  return orderAnswers(answer ? [...rest, { change, source, answer }] : rest);
}

/** How a standing answer reads in Settings: "Jira Cloud · Move to In progress: Allow always". */
export function ticketAnswerText(a: TicketAnswer): string {
  return `${ANSWER_SOURCE_LABEL[a.source]} · ${TICKET_CHANGE_LABEL[a.change]}: ${a.answer === 'always' ? 'Allow always' : 'Don’t ask'}`;
}

const STAGE: Record<TicketCategory, number> = { todo: 0, 'in-progress': 1, 'in-review': 2, done: 3 };

/** Whether a ticket already stands where the move would take it, or further on: then the move is not proposed. */
export function alreadyAtOrPast(category: TicketCategory, change: Exclude<TicketChange, 'comment'>): boolean {
  return STAGE[category] >= STAGE[change];
}
