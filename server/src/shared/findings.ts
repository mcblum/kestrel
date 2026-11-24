// A finding: one problem a review found, said once (0.0.23; one shape for both reviews since
// 2026-11-24, Matt: "I like the 'findings' components better ... let's move to that style"). The
// review of somebody else's pull request (shared/review-reply.ts) and the rounds review of a
// session's own work (shared/round-findings.ts) both hand findings over in this shape, and the page
// draws both with one component (ui FindingCard.tsx). A finding has a brief anyone can read, a
// technical explanation that starts folded, a suggested fix, a priority, whether the reviewer thinks
// it blocks, the lines of code it is about, and, since 2026-11-24, a question the reviewer puts to
// the user about it and the user's answer. Pure and browser-safe.

import { ASIDE_WORD, type AsideSubject } from './asides.ts';

export type FindingPriority = 'high' | 'medium' | 'low';
/** The priorities, highest first: the one order every card and every posted review uses. */
export const FINDING_PRIORITIES: readonly FindingPriority[] = ['high', 'medium', 'low'];
export const PRIORITY_LABEL: Record<FindingPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** A line of code a finding is about. */
export interface FindingRef {
  path: string;
  line: number;
  /** The last line, when the finding is about a range of lines (`line` is the first). */
  end?: number;
}

/** One problem a review found. */
export interface Finding {
  /** Its name within the review: f1, f2, … Never changes, so an edit or an action says which one it is of. */
  id: string;
  /** One or two plain sentences: what is wrong. Always shown. */
  brief: string;
  /** The technical explanation: why, precisely enough for an engineer (or a model) to act on. Folded until asked for. */
  detail?: string;
  /** What to do instead. */
  fix?: string;
  priority: FindingPriority;
  /** The reviewer's opinion (or the user's, once they change it) that this must be fixed before the change merges. */
  blocking: boolean;
  /** The lines it is about; the first is where a posted comment goes. None: it is about the change as a whole. */
  refs: FindingRef[];
  /** The user took it out: kept on the card, not posted (a pull-request review) or not acted on (a rounds review). */
  dismissed?: boolean;
  /** A question the reviewer puts to the user about this finding, when only the user can say. Added 2026-11-24. */
  question?: string;
  /** The user's answer to `question`, once given; it went to the session the card is in. Set by Kestrel only. */
  answer?: string;
  /** The user asked the session the card is in to fix this one (a rounds review). Set by Kestrel only. */
  fixAsked?: boolean;
  /** A rounds review: the round it was first raised in, when that was an earlier round than the card's (it was carried forward, the same finding). Set by Kestrel only. Added 2026-11-24. */
  since?: number;
  /** The reviewer never handed its findings over as findings: this one is its words, whole, and this says why. Set by Kestrel only. Added 2026-11-24. */
  unstructured?: string;
}

export const BRIEF_MAX = 600;
export const DETAIL_MAX = 5_000;
export const FIX_MAX = 2_000;
export const QUESTION_MAX = 600;
export const ANSWER_MAX = 4_000;
export const FINDINGS_MAX = 50;
export const REFS_MAX = 5;

const isPriority = (v: unknown): v is FindingPriority => FINDING_PRIORITIES.includes(v as FindingPriority);
const optionalText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** One reference as given, or why it is not one. */
function checkRef(rawRef: unknown, at: string): FindingRef | string {
  const r = (typeof rawRef === 'object' && rawRef !== null ? rawRef : {}) as Record<string, unknown>;
  const path = typeof r.path === 'string' ? r.path.trim().replace(/^\.\//, '') : '';
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return `${at}: a reference's path must be a file relative to the repository.`;
  if (typeof r.line !== 'number' || !Number.isInteger(r.line) || r.line < 1) return `${at}: a reference's line must be a line number, 1 or more.`;
  if (r.end === undefined || r.end === null || r.end === r.line) return { path, line: r.line };
  if (typeof r.end !== 'number' || !Number.isInteger(r.end) || r.end < r.line) return `${at}: a reference's end must be a line number, no less than its line.`;
  return { path, line: r.line, end: r.end };
}

/** What only Kestrel sets on a finding (the user's answer, a fix asked for), carried over as it was. */
function kestrelMarks(f: Record<string, unknown>): Pick<Finding, 'answer' | 'fixAsked' | 'since' | 'unstructured'> {
  const answer = optionalText(f.answer).slice(0, ANSWER_MAX);
  const unstructured = optionalText(f.unstructured).slice(0, BRIEF_MAX);
  const since = typeof f.since === 'number' && Number.isInteger(f.since) && f.since > 0 ? f.since : 0;
  return { ...(answer ? { answer } : {}), ...(f.fixAsked === true ? { fixAsked: true } : {}), ...(since ? { since } : {}), ...(unstructured ? { unstructured } : {}) };
}

/** One finding as given, or why it is not one. */
function checkFinding(raw: unknown, i: number, id: string, keepMarks: boolean): Finding | string {
  const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const at = `Finding ${i + 1}`;
  const brief = optionalText(f.brief);
  const detail = optionalText(f.detail);
  const fix = optionalText(f.fix);
  const question = optionalText(f.question);
  if (!brief) return `${at}: brief is empty. Say in a sentence or two what is wrong.`;
  if (brief.length > BRIEF_MAX) return `${at}: brief is longer than ${BRIEF_MAX} characters. Keep it to a sentence or two; the rest goes in detail.`;
  if (detail.length > DETAIL_MAX) return `${at}: detail is longer than ${DETAIL_MAX} characters.`;
  if (fix.length > FIX_MAX) return `${at}: fix is longer than ${FIX_MAX} characters.`;
  if (question.length > QUESTION_MAX) return `${at}: question is longer than ${QUESTION_MAX} characters. Ask one plain question.`;
  if (!isPriority(f.priority)) return `${at}: priority must be one of: ${FINDING_PRIORITIES.join(', ')}.`;
  if (typeof f.blocking !== 'boolean') return `${at}: blocking must be true or false.`;
  const givenRefs = f.refs === undefined || f.refs === null ? [] : f.refs;
  if (!Array.isArray(givenRefs)) return `${at}: refs must be a list of { path, line }.`;
  if (givenRefs.length > REFS_MAX) return `${at}: at most ${REFS_MAX} code references.`;
  const refs: FindingRef[] = [];
  for (const rawRef of givenRefs) {
    const ref = checkRef(rawRef, at);
    if (typeof ref === 'string') return ref;
    refs.push(ref);
  }
  return {
    id,
    brief,
    ...(detail ? { detail } : {}),
    ...(fix ? { fix } : {}),
    priority: f.priority,
    blocking: f.blocking,
    refs,
    ...(f.dismissed === true ? { dismissed: true } : {}),
    ...(question ? { question } : {}),
    ...(keepMarks ? kestrelMarks(f) : {}),
  };
}

/**
 * Findings as given (by the agent, or by the user's edits), checked: the list, or the reason it is
 * not one. `ids` names each finding when the caller already has names for them (an edit keeps the
 * card's own, and the marks only Kestrel sets); otherwise they are numbered and those marks dropped.
 */
export function checkFindings(given: unknown, ids?: readonly string[]): { findings: Finding[] } | { problem: string } {
  if (given === undefined || given === null) return { findings: [] };
  if (!Array.isArray(given)) return { problem: 'findings must be a list.' };
  if (given.length > FINDINGS_MAX) return { problem: `At most ${FINDINGS_MAX} findings. Keep the ones that matter most.` };
  const findings: Finding[] = [];
  for (const [i, raw] of given.entries()) {
    const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const id = ids?.[i] ?? (typeof f.id === 'string' && /^f\d+$/.test(f.id) ? f.id : `f${i + 1}`);
    const checked = checkFinding(raw, i, id, ids !== undefined);
    if (typeof checked === 'string') return { problem: checked };
    findings.push(checked);
  }
  return { findings };
}

/** Findings as an agent hands them over: nothing dismissed or answered yet, each named by its place. */
export function freshFindings(given: unknown): { findings: Finding[] } | { problem: string } {
  const checked = checkFindings(given);
  if ('problem' in checked) return checked;
  return { findings: checked.findings.map(({ dismissed: _d, answer: _a, fixAsked: _f, since: _s, unstructured: _u, ...f }, i) => ({ ...f, id: `f${i + 1}` })) };
}

/** The findings still in: the ones not dismissed. */
export const keptFindings = <T extends Pick<Finding, 'dismissed'>>(findings: readonly T[]): T[] => findings.filter((f) => !f.dismissed);

/** The kept findings marked blocking. */
export const blockingFindings = <T extends Pick<Finding, 'dismissed' | 'blocking'>>(findings: readonly T[]): T[] => keptFindings(findings).filter((f) => f.blocking);

/** A kept finding whose question the user has not answered yet. */
export const openQuestion = (f: Pick<Finding, 'question' | 'answer' | 'dismissed'>): boolean => Boolean(f.question) && !f.answer && !f.dismissed;

/**
 * "3 findings: 1 high, 2 medium · 1 blocks · 1 dismissed": what a card holds, at a glance, with how
 * many there are at each priority, highest first (Matt, 2026-11-24: the priority "might be the most
 * important").
 */
export function countLine(findings: readonly Pick<Finding, 'blocking' | 'dismissed' | 'priority'>[]): string {
  const kept = keptFindings(findings);
  const blocking = kept.filter((f) => f.blocking).length;
  const dismissed = findings.length - kept.length;
  const byPriority = FINDING_PRIORITIES.map((p) => [p, kept.filter((f) => f.priority === p).length] as const).filter(([, n]) => n > 0);
  const total = `${kept.length} finding${kept.length === 1 ? '' : 's'}`;
  const head = byPriority.length > 0 ? `${total}: ${byPriority.map(([p, n]) => `${n} ${PRIORITY_LABEL[p].toLowerCase()}`).join(', ')}` : total;
  return [head, blocking > 0 ? `${blocking} block${blocking === 1 ? 's' : ''}` : null, dismissed > 0 ? `${dismissed} dismissed` : null].filter(Boolean).join(' · ');
}

/** A priority's rank: its place in FINDING_PRIORITIES, the one order, highest first. */
const rank = (p: FindingPriority): number => FINDING_PRIORITIES.indexOf(p);

/** Highest priority first, then the ones that block; findings that tie keep the reviewer's order. */
export function orderFindings<T extends Pick<Finding, 'blocking' | 'priority'>>(findings: readonly T[]): T[] {
  return findings.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.priority) - rank(b.f.priority) || Number(b.f.blocking) - Number(a.f.blocking) || a.i - b.i).map(({ f }) => f);
}

/** A finding's number from its id: f3 is 3. */
export const idNumber = (id: string): number => Number(/^f(\d+)$/.exec(id)?.[1] ?? 0);

/**
 * The findings in the order a card shows them (highest priority first, the dismissed ones
 * last) with each kept one's number, from 1: "Finding 2" means the same one on the card, in the
 * sidebar and in what is sent about it. `byId`: the number is the finding's own (f3 is 3), for a
 * rounds review, where a finding carried into the next round keeps its number and a fixed one
 * leaves a gap.
 */
export function numberedFindings<T extends Pick<Finding, 'id' | 'blocking' | 'priority' | 'dismissed'>>(findings: readonly T[], byId = false): { shown: T[]; numberOf: Map<string, number> } {
  const shown = [...orderFindings(keptFindings(findings)), ...findings.filter((f) => f.dismissed)];
  return { shown, numberOf: new Map(shown.filter((f) => !f.dismissed).map((f, i) => [f.id, byId ? idNumber(f.id) || i + 1 : i + 1])) };
}

/** "High priority · Blocks" / "Medium priority": how a finding is marked where it is posted and sent, its priority first. */
export const findingMark = (f: Pick<Finding, 'blocking' | 'priority'>): string => `${PRIORITY_LABEL[f.priority]} priority${f.blocking ? ' · Blocks' : ''}`;

/**
 * How a card marks a finding's priority, in a word that reads without colour: "High", "Medium",
 * "Low". Grey chrome stays grey (CLAUDE.md): the three differ by weight (filled ink, outlined,
 * soft), never by a hue, so red keeps meaning one thing on a finding, that it blocks.
 */
export const priorityMark = (p: FindingPriority): { kind: FindingPriority; label: string } => ({ kind: p, label: PRIORITY_LABEL[p] });

/** A finding in plain text: its mark, the brief, then the explanation, the fix, where, and any question and answer. */
export function findingText(f: Finding, number?: number): string {
  const where = f.refs.length > 0 ? `At: ${f.refs.map((r) => `${r.path}:${r.line}`).join(', ')}` : undefined;
  return [
    `${number !== undefined ? `Finding ${number} · ` : ''}${findingMark(f)}. ${f.brief}`,
    f.detail,
    f.fix ? `Suggested fix: ${f.fix}` : undefined,
    where,
    f.question ? `Question for the user: ${f.question}` : undefined,
    f.answer ? `The user's answer: ${f.answer}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

const SUMMARY_MAX = 160;

/** A finding in a line, for a heading or a placeholder: its brief, cut at a sentence or a word. */
export function findingSummary(f: Pick<Finding, 'brief'>): string {
  const text = f.brief.replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${(end > SUMMARY_MAX / 2 ? cut.slice(0, end) : cut).replace(/[.,;:]$/, '')}…`;
}

/** "Finding #2", or "this finding" when it has no number on its card. */
export const findingName = (number: number | undefined): string => (number !== undefined ? `Finding #${number}` : 'this finding');

/** What a sidebar about a finding is about (shared/asides.ts): its name, its brief in a line, and the finding in full for the agent. */
export const findingSubject = (f: Finding, number: number | undefined): AsideSubject => ({ name: findingName(number), summary: findingSummary(f), context: `The finding:\n\n${findingText(f, number)}` });

/** Which sidebar is the one about a finding: one per finding of a card. */
export const findingAsideKey = (cardId: string, findingId: string): string => `finding:${cardId}:${findingId}`;

/** What a finding's control says. */
export const START_FINDING_ASIDE = `Start ${ASIDE_WORD} about this finding`;
