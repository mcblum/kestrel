// The findings of one round of the review of a session's own work (delegation.ts `startReview`), as
// a card in that session's conversation (2026-11-24). The reviewer hands them over with
// `post_review`, in the one finding shape (shared/findings.ts); the author is given them as news for
// its next turn and the user sees the card, drawn by the same component as a pull-request review's.
// They warn and never block: nothing waits on the card, and the user may act on any finding at any
// time (ask for it to be fixed, answer the reviewer's question about it, dismiss it, or talk it over
// in a sidebar). Pure and browser-safe.
//
// What the user sees are always findings (Matt, 2026-11-24): a reviewer that answers only in text is
// asked once to hand them over properly, and if it still does not, its words become one finding
// marked as unstructured, with why (`unstructuredFinding`). From the second round the reviewer says
// what became of each finding of the round before (`earlier`): fixed, still open or withdrawn, and
// whether and in which commit the author says it fixed it. A finding still open is carried forward,
// the same finding with the same number (`carryForward`), not a new one.
//
// When the review ends with findings still open, the author's conversation gets a card that stays
// above the message box until the user carries on (`ReviewEnd`). It reads the findings from the last
// round's card, so there is one copy of them, and every action on it is a finding's own.
import { blockingFindings, BRIEF_MAX, DETAIL_MAX, findingText, FINDING_PRIORITIES, idNumber, keptFindings, numberedFindings, orderFindings, type Finding, type FindingPriority } from './findings.ts';
import type { ReviewVerdict } from './review-reply.ts';

/** What became of a finding of the round before, as the reviewer says when it looks again. */
export type EarlierStatus = 'fixed' | 'open' | 'withdrawn' | 'unknown';
export const EARLIER_STATUSES: readonly Exclude<EarlierStatus, 'unknown'>[] = ['fixed', 'open', 'withdrawn'];

export interface EarlierFinding {
  /** The finding of the round before (its id, so its number). */
  id: string;
  /** Its brief and priority as they were, so the card can name a fixed one that is on no later card. */
  brief: string;
  priority: FindingPriority;
  /** `fixed`: the reviewer checked it is. `open`: it still holds, and is carried forward. `withdrawn`: the reviewer accepts the author's disagreement. `unknown`: the reviewer did not say (it never handed over findings). */
  status: EarlierStatus;
  /** The author says it fixed it. */
  claimed?: boolean;
  /** The commit the author says it fixed it in. */
  commit?: string;
  /** The reviewer's few words on it. */
  note?: string;
}

export interface RoundFindings {
  /** Who reviewed, in words ("Astra (Codex · …)"). */
  reviewer: string;
  /** The reviewer's session. */
  reviewerId: string;
  /** The round these are of, from 1, and how many there are. */
  round: number;
  rounds: number;
  /** `findings`: something must change before this is merged; `clean`: nothing must. */
  verdict: 'clean' | 'findings';
  /** The reviewer's few sentences on the work. */
  summary: string;
  findings: Finding[];
  /** From the second round: what became of each finding of the round before. Added 2026-11-24. */
  earlier?: EarlierFinding[];
  /** The reviewer's message its round ended on: where "Open the review" takes the user. Added 2026-11-24. */
  at?: string;
  /**
   * The review ended with this round: these are the findings as they finally stand, drawn as the full
   * findings card with its actions. A round before it (absent) was passed between reviewer and author
   * and is drawn as one quiet folded line (Matt, 2026-11-24: "at the point where the parent has heard
   * from the sub-agent and the findings are the findings, then the parent should display the findings
   * cards"). Added 2026-11-24.
   */
  final?: true;
}

export const NOTE_MAX = 600;
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** What the reviewer's hand-over concluded: something must change when it asked for changes or a kept finding blocks. */
export const roundVerdict = (verdict: ReviewVerdict, findings: readonly Finding[]): 'clean' | 'findings' => (verdict === 'request_changes' || blockingFindings(findings).length > 0 ? 'findings' : 'clean');

/** A rounds card's numbering: each finding keeps its own number from round to round. */
export const roundNumbered = <T extends Pick<Finding, 'id' | 'blocking' | 'priority' | 'dismissed'>>(findings: readonly T[]) => numberedFindings(findings, true);

/** "Finding 2" for a finding's id. */
const named = (id: string): string => `Finding ${idNumber(id)}`;

/** One earlier finding's fate in words: "Finding 2: fixed, in abc1234." */
export function earlierText(e: EarlierFinding): string {
  const commit = e.commit ? ` in ${e.commit.slice(0, 7)}` : '';
  const said = e.claimed ? `the author says it fixed it${commit}` : '';
  const fate =
    e.status === 'fixed'
      ? `fixed${commit}`
      : e.status === 'withdrawn'
        ? 'withdrawn by the reviewer'
        : e.status === 'open'
          ? `still open${said ? `, though ${said}` : ''}`
          : `the reviewer did not say what became of it${said ? ` (${said})` : ''}`;
  return `${named(e.id)}: ${fate}.${e.note ? ` ${e.note}` : ''}`;
}

/** The findings in plain text, numbered as the card numbers them: what the author is told and a pull request's description carries. */
export function roundFindingsText(card: Pick<RoundFindings, 'summary' | 'findings' | 'earlier'>): string {
  const { shown, numberOf } = roundNumbered(card.findings);
  const kept = shown.filter((f) => !f.dismissed);
  const earlier = card.earlier?.length ? `Since the round before:\n${card.earlier.map(earlierText).join('\n')}` : '';
  return [card.summary, earlier, ...kept.map((f) => findingText(f, numberOf.get(f.id)))].filter(Boolean).join('\n\n');
}

/** The line the author's conversation shows with the card; the findings themselves reach the agent as news with it. */
export function roundNotice(card: Pick<RoundFindings, 'reviewer' | 'round' | 'rounds'>): string {
  const after = card.round < card.rounds ? `When your turn ends, ${card.reviewer} looks again (round ${card.round + 1} of ${card.rounds}).` : 'This was the last round: the user decides from here.';
  return `[Kestrel] ${card.reviewer} reviewed your work (round ${card.round} of ${card.rounds}); its findings come with this message. For each: fix it if it is right, and if you disagree say so and why, briefly. Do not argue style, and leave a question the reviewer put to the user for the user. Then say what you did with each, by its number, and the commit a fix is in when you committed it ("Finding 2: fixed in abc1234", "Finding 3: not changed, because …"). ${after}`;
}

/** The findings as news for the author's turn: what the card shows, in words. */
export const roundNews = (card: RoundFindings): string => `[Kestrel] ${card.reviewer}'s findings, round ${card.round} of ${card.rounds}:\n\n${roundFindingsText(card)}`;

/** What the user's "Ask to fix" sends to the session whose work it is. */
export function fixMessage(f: Finding, number: number | undefined, reviewer: string): string {
  return `Please fix this finding from ${reviewer}'s review:\n\n${findingText(f, number)}`;
}

/** What "Ask to fix" sends for several findings at once, from the card that stays after the review. */
export function fixAllMessage(findings: readonly { finding: Finding; number: number | undefined }[], reviewer: string): string {
  if (findings.length === 1) return fixMessage(findings[0]!.finding, findings[0]!.number, reviewer);
  return `Please fix these ${findings.length} findings from ${reviewer}'s review:\n\n${findings.map(({ finding, number }) => findingText(finding, number)).join('\n\n')}`;
}

/** What answering a finding's question sends to the session the card is in. */
export function answerMessage(f: Finding, number: number | undefined, answer: string): string {
  return `About ${number !== undefined ? `finding ${number}` : 'a finding'} of the review ("${f.brief}"), the question was: ${f.question ?? ''}\n\nMy answer: ${answer}`;
}

// ---- carried forward ---------------------------------------------------------------------------

/**
 * The reviewer's word on the round before's findings, checked against them: every kept finding of
 * that round accounted for once, or the reason it is not. `previous` is that round's card's findings.
 */
export function checkEarlier(given: unknown, previous: readonly Finding[]): { earlier: EarlierFinding[] } | { problem: string } {
  const owed = keptFindings(previous);
  const list = given === undefined || given === null ? [] : given;
  if (!Array.isArray(list)) return { problem: 'earlier must be a list of { id, status }.' };
  if (owed.length === 0) return list.length === 0 ? { earlier: [] } : { problem: 'There is no finding of an earlier round to account for: leave earlier out.' };
  const byId = new Map(owed.map((f) => [f.id, f]));
  const earlier: EarlierFinding[] = [];
  for (const raw of list) {
    const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const was = byId.get(id);
    if (!was) return { problem: `earlier names "${id}", which is not a finding of the round before. Its findings are ${owed.map((f) => f.id).join(', ')}.` };
    if (earlier.some((x) => x.id === id)) return { problem: `earlier names ${id} twice.` };
    if (!EARLIER_STATUSES.includes(e.status as never)) return { problem: `${id}: status must be one of ${EARLIER_STATUSES.join(', ')}.` };
    const commit = typeof e.commit === 'string' ? e.commit.trim() : '';
    if (commit && !COMMIT.test(commit)) return { problem: `${id}: commit must be a commit's hash (7 to 40 hex characters).` };
    const note = typeof e.note === 'string' ? e.note.trim() : '';
    if (note.length > NOTE_MAX) return { problem: `${id}: note is longer than ${NOTE_MAX} characters.` };
    earlier.push({ id, brief: was.brief, priority: was.priority, status: e.status as EarlierStatus, ...(e.author_says_fixed === true ? { claimed: true } : {}), ...(commit ? { commit } : {}), ...(note ? { note } : {}) });
  }
  const missing = owed.filter((f) => !earlier.some((e) => e.id === f.id));
  if (missing.length > 0) return { problem: `Say in earlier what became of ${missing.map((f) => `${f.id} ("${f.brief.slice(0, 60)}")`).join(', ')} from the round before: fixed, open or withdrawn.` };
  return { earlier: orderEarlier(earlier) };
}

/** Earlier findings, the ones still open first, then by priority. */
const orderEarlier = (earlier: readonly EarlierFinding[]): EarlierFinding[] => {
  const rank = (e: EarlierFinding) => (e.status === 'open' ? 0 : 1) * 10 + FINDING_PRIORITIES.indexOf(e.priority);
  return [...earlier].sort((a, b) => rank(a) - rank(b));
};

/** Every earlier finding marked `unknown`: the reviewer never said (it answered in text only). */
export const earlierUnknown = (previous: readonly Finding[]): EarlierFinding[] => keptFindings(previous).map((f) => ({ id: f.id, brief: f.brief, priority: f.priority, status: 'unknown' }));

/** The highest finding number a card has used, its earlier findings included. */
export const lastNumber = (card: Pick<RoundFindings, 'findings' | 'earlier'> | null): number => Math.max(0, ...(card?.findings ?? []).map((f) => idNumber(f.id)), ...(card?.earlier ?? []).map((e) => idNumber(e.id)));

/**
 * A round's findings: the round before's findings the reviewer still holds, the same findings (same
 * id, same number, marked with the round they were first raised in), then the new ones, numbered on
 * from the last number used, highest priority first.
 */
export function carryForward(previous: RoundFindings | null, earlier: readonly EarlierFinding[], fresh: readonly Finding[]): Finding[] {
  const open = new Set(earlier.filter((e) => e.status === 'open').map((e) => e.id));
  const carried = (previous?.findings ?? []).filter((f) => open.has(f.id) && !f.dismissed).map(({ fixAsked: _f, ...f }) => ({ ...f, since: f.since ?? previous!.round }));
  let next = lastNumber(previous);
  const added = orderFindings(fresh).map((f) => ({ ...f, id: `f${(next += 1)}` }));
  return [...carried, ...added];
}

/** The reviewer's text as the one finding, when it never handed over findings: nothing it said is lost, and the card says why it looks this way. */
export function unstructuredFinding(said: string, reviewer: string, previous: RoundFindings | null): Finding {
  const text = said.trim() || '(It wrote nothing.)';
  return {
    id: `f${lastNumber(previous) + 1}`,
    brief: `${reviewer} says something must change, but gave its findings only as text. Its words are under the explanation.`.slice(0, BRIEF_MAX),
    detail: text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text,
    priority: 'high',
    blocking: true,
    refs: [],
    unstructured: `${reviewer} was asked twice to hand its findings over as findings and answered in text both times, so Kestrel could not give them a priority or a line of code.`,
  };
}

// ---- after the review ---------------------------------------------------------------------------

/** How the review of this session's work ended with findings still open: a card that stays until the user carries on. Added 2026-11-24. */
export interface ReviewEnd {
  reviewer: string;
  reviewerId: string;
  /** How many rounds it ran. */
  rounds: number;
  /** The message id of its last round's card, in the same conversation: the findings are read there. Absent when that round left none. */
  card?: string;
  /** The reviewer's message its last round ended on. */
  at?: string;
  /** `open`: shown above the message box, and the session needs the user. `closed`: the user carried on. */
  state: 'open' | 'closed';
  /** Why it ended early, when it did (the reviewer could not look again). */
  problem?: string;
}

/** A review-end card's message id. */
export const reviewEndId = (reviewerId: string): string => `review-end-${reviewerId}`;

export function sanitizeReviewEnd(value: unknown): ReviewEnd | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.reviewer !== 'string' || typeof v.reviewerId !== 'string') return null;
  return {
    reviewer: v.reviewer,
    reviewerId: v.reviewerId,
    rounds: typeof v.rounds === 'number' ? v.rounds : 1,
    ...(typeof v.card === 'string' ? { card: v.card } : {}),
    ...(typeof v.at === 'string' ? { at: v.at } : {}),
    state: v.state === 'closed' ? 'closed' : 'open',
    ...(typeof v.problem === 'string' && v.problem ? { problem: v.problem } : {}),
  };
}

type Messages = readonly { id?: string; roundFindings?: RoundFindings; reviewEnd?: ReviewEnd }[];

/** The findings a review-end card is about: its last round's kept ones, highest priority first, with their numbers. */
export function openFindings(messages: Messages, end: Pick<ReviewEnd, 'card'>): { findings: Finding[]; numberOf: Map<string, number> } {
  const round = end.card ? messages.find((m) => m.id === end.card)?.roundFindings : undefined;
  const { shown, numberOf } = roundNumbered(round?.findings ?? []);
  return { findings: shown.filter((f) => !f.dismissed), numberOf };
}

/** The open review-end card of a conversation, the newest: what sits above the message box. */
export function shownReviewEnd(messages: Messages | undefined): { id: string; end: ReviewEnd } | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = messages![i]!;
    if (m.reviewEnd && m.id) return m.reviewEnd.state === 'open' ? { id: m.id, end: m.reviewEnd } : null;
  }
  return null;
}

/** The line the conversation keeps where the review ended with findings. */
export function reviewEndLine(end: Pick<ReviewEnd, 'reviewer' | 'rounds' | 'state' | 'problem'>, open: number): string {
  const rounds = end.rounds === 1 ? '1 round' : `${end.rounds} rounds`;
  const left = open === 0 ? 'no finding is left open' : `${open} finding${open === 1 ? ' is' : 's are'} still open`;
  return `${end.reviewer} reviewed this work (${rounds}): ${left}. They warn and never block.${end.problem ? ` ${end.problem}` : ''}`;
}

/** What the session's row says while the card waits. */
export const REVIEW_END_NOTE = 'Needs you · Review findings';

/** What the user does with the review-end card (review-end.ts): the window's buttons and a phone's `reviewEnd.act`. */
export const REVIEW_END_ACTIONS = ['fix', 'close', 'reopen'] as const;
export type ReviewEndAction = (typeof REVIEW_END_ACTIONS)[number];
