// A review of somebody else's pull request, as the agent hands it over with `post_review` and as
// it is posted: a verdict, a short summary, and findings (0.0.23; Matt, 2026-11-21). A finding is
// one problem, said once, in the one shape both reviews use (shared/findings.ts). The user may change any of it and dismiss any finding before posting; what is kept goes
// to the host as comments on lines. It is a card in the conversation; nothing reaches the host
// until the user posts it (or chose "Review and reply on their own"). Pure and browser-safe.

import { blockingFindings, checkFindings, findingMark, freshFindings, keptFindings, orderFindings, type Finding, type FindingRef } from './findings.ts';
import { placeFinding, refText, type DiffAnchors } from './diff-anchors.ts';

// The finding's shape is one, in shared/findings.ts (2026-11-24); these names stay for the callers that had them.
export { BRIEF_MAX, DETAIL_MAX, FIX_MAX, FINDINGS_MAX, REFS_MAX, FINDING_PRIORITIES, PRIORITY_LABEL, checkFindings, keptFindings, blockingFindings, orderFindings, findingMark } from './findings.ts';
export type { FindingPriority, FindingRef } from './findings.ts';
/** A finding of a pull-request review: the one finding shape (shared/findings.ts). */
export type ReviewFinding = Finding;

export type ReviewVerdict = 'comment' | 'approve' | 'request_changes';

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['comment', 'approve', 'request_changes'];

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  comment: 'Comment',
  approve: 'Approve',
  request_changes: 'Request changes',
};

/** What a posted review is called afterwards: "Posted as …". */
export const VERDICT_POSTED: Record<ReviewVerdict, string> = {
  comment: 'a comment',
  approve: 'an approval',
  request_changes: 'a request for changes',
};

export interface ReviewLineComment {
  /** The finding it carries. */
  findingId?: string;
  /** The file, relative to the repository. */
  path: string;
  /** The line in the file as the request leaves it (the last line, for a range). */
  line: number;
  /** The first line of a range; absent for one line. */
  start?: number;
  /** The line in the old file, for a line that was there before the change. */
  oldLine?: number;
  /** The file's path before the change, when it was renamed. */
  oldPath?: string;
  body: string;
}

export interface ReviewReply {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  /** The commit the review is of: the session's review mark when the agent handed it over. */
  sha: string;
  /** Which lines of the request's diff can take a comment, read from the reviewed commit when the review was handed over (shared/diff-anchors.ts). Absent: it could not be read. */
  anchors?: DiffAnchors;
  /** Set once it reached the host. */
  posted?: ReviewPosted;
}

export interface ReviewPosted {
  /** The host received only the approval: the summary, and any findings still kept, stayed in Kestrel. */
  withoutComment?: boolean;
  at: number;
  verdict: ReviewVerdict;
  /** True when Kestrel posted it without the user's click (the setting's fourth choice). */
  onItsOwn?: boolean;
  /** Something the user should know about how it went up: comments folded into the summary, say. */
  note?: string;
  /** Where each kept finding went, by id, when that differs from where the card said it would go: the host refused its line. */
  moved?: Record<string, string>;
}

export const SUMMARY_MAX = 20_000;

const isVerdict = (v: unknown): v is ReviewVerdict => REVIEW_VERDICTS.includes(v as ReviewVerdict);

/** A summary as given, or why it will not do. */
export function summaryProblem(summary: unknown, allowEmpty = false): string | null {
  if (typeof summary !== 'string' || (!allowEmpty && !summary.trim())) return 'summary is empty. Say what the change does and what you make of it.';
  if (summary.length > SUMMARY_MAX) return `summary is longer than ${SUMMARY_MAX} characters.`;
  return null;
}

export const verdictProblem = (verdict: unknown): string | null => (isVerdict(verdict) ? null : `verdict must be one of: ${REVIEW_VERDICTS.join(', ')}.`);

/** What `post_review` was given, checked: the review, or the reason it is not one. */
export function draftReview(args: { verdict?: unknown; summary?: unknown; findings?: unknown }, sha: string): { reply: ReviewReply } | { problem: string } {
  const problem = verdictProblem(args.verdict);
  if (problem) return { problem };
  const checked = freshFindings(args.findings);
  if ('problem' in checked) return checked;
  const summaryError = summaryProblem(args.summary);
  if (summaryError) return { problem: summaryError };
  // As the agent hands it over nothing is dismissed or answered, and each is named by its place.
  return { reply: { verdict: args.verdict as ReviewVerdict, summary: (args.summary as string).trim(), findings: checked.findings, sha } };
}

/**
 * The user's changes to a card's findings, applied: each edited finding replaces the card's own of
 * the same id, in the card's order. A finding the edit does not mention stays as it was, and one it
 * invents is ignored: the user changes and dismisses findings, the agent makes them.
 */
export function editedFindings(own: readonly ReviewFinding[], edit: unknown): { findings: ReviewFinding[] } | { problem: string } {
  if (edit === undefined) return { findings: [...own] };
  if (!Array.isArray(edit)) return { problem: 'findings must be a list.' };
  const byId = new Map<string, unknown>(edit.flatMap((raw) => (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string' ? [[(raw as { id: string }).id, raw] as const] : [])));
  // The question is the agent's, and the answer is Kestrel's record of what the user sent: an edit changes neither.
  const merged = own.map((f) => {
    const edited = byId.get(f.id);
    if (typeof edited !== 'object' || edited === null) return f;
    const { question: _q, answer: _a, fixAsked: _x, ...rest } = edited as Record<string, unknown>;
    return { ...rest, ...(f.question ? { question: f.question } : {}), ...(f.answer ? { answer: f.answer } : {}), ...(f.fixAsked ? { fixAsked: true } : {}) };
  });
  return checkFindings(merged, own.map((f) => f.id));
}

/** A review as it goes to a host: findings already turned into comments on lines (`postable`). */
export interface OutgoingReview {
  verdict: ReviewVerdict;
  /** The reviewer's own words. */
  summary: string;
  /** The findings that go on the code. */
  comments: ReviewLineComment[];
  /** The findings written under the summary, each as posted. */
  loose?: string[];
  sha: string;
}

/** The summary as it reaches the host: the reviewer's words, how many findings are on the code, then the ones that are not. */
export const postedSummary = (out: Pick<OutgoingReview, 'summary' | 'comments' | 'loose'>): string => summaryWith(out.summary, out.comments.length, out.loose ?? []);

/** The review with these comments written under the summary instead: what goes up when the host refuses their lines. */
export function withFolded(out: OutgoingReview, refused: readonly ReviewLineComment[]): OutgoingReview {
  const kept = out.comments.filter((c) => !refused.includes(c));
  return { ...out, comments: kept, loose: [...(out.loose ?? []), ...refused.map((c) => `**${c.path}:${c.start !== undefined ? `${c.start}–` : ''}${c.line}**\n${c.body}`)] };
}


/**
 * An approval with nothing to say to the author: no finding is kept. It goes to the host as the
 * approval alone unless the user asks for the summary to go with it (Matt, 2026-11-21: the summary
 * says why the change is fine, which is for the reviewer, not a comment on somebody's pull
 * request). This is only where the card's choice starts and what a review posted on its own does:
 * the user may post any approval without comment, findings or not.
 */
export const isCleanApproval = (verdict: ReviewVerdict, findings: readonly ReviewFinding[]): boolean => verdict === 'approve' && keptFindings(findings).length === 0;

/**
 * The verdict a card proposes, which follows its findings: asking for changes while a kept finding
 * blocks; and when none does, never asking for changes on the agent's word alone (the user
 * dismissed, or unmarked, what it was for), so a comment. An approval or a comment the agent chose
 * stands when nothing blocks.
 */
export function verdictFor(agentVerdict: ReviewVerdict, findings: readonly ReviewFinding[]): ReviewVerdict {
  if (blockingFindings(findings).length > 0) return 'request_changes';
  return agentVerdict === 'request_changes' ? 'comment' : agentVerdict;
}

/**
 * A finding as it is posted: its priority and whether it blocks, the brief, then the explanation and
 * the fix. On the code (`on` is the line it is on) it names its other lines; in the summary it names
 * all of them.
 */
export function findingBody(f: ReviewFinding, on?: FindingRef): string {
  const others = on ? f.refs.filter((r) => r !== on) : f.refs;
  return [
    `**${findingMark(f)}.** ${f.brief}`,
    f.detail,
    f.fix ? `**Suggested fix:** ${f.fix}` : undefined,
    others.length > 0 ? `${on ? 'Also' : 'At'}: ${others.map((r) => `\`${refText(r)}\``).join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The line the summary carries when some findings are on the code. */
export const onTheCodeLine = (n: number): string => `${n} finding${n === 1 ? ' is a comment' : 's are comments'} on the code.`;

/**
 * What goes to the host for a review's kept findings, highest priority first: each one whose line is
 * part of the request's diff as a comment on that line (`placeFinding`), and the rest written under
 * the summary with their references, after a line saying how many are on the code. Dismissed ones go
 * nowhere. Nothing at all when the approval goes up without comment.
 */
export function postable(reply: Pick<ReviewReply, 'summary' | 'findings' | 'anchors'>, withoutComment = false): { summary: string; comments: ReviewLineComment[]; loose: string[] } {
  // "Approve without comment": the approval alone. The summary and the findings stay on the card.
  if (withoutComment) return { summary: '', comments: [], loose: [] };
  const kept = orderFindings(keptFindings(reply.findings));
  const comments: ReviewLineComment[] = [];
  const loose: string[] = [];
  for (const f of kept) {
    const placed = placeFinding(f, reply.anchors);
    if (placed.where === 'summary') loose.push(findingBody(f));
    else comments.push({ findingId: f.id, path: placed.ref.path, line: placed.line, ...(placed.start !== undefined ? { start: placed.start } : {}), ...(placed.oldLine ? { oldLine: placed.oldLine } : {}), ...(placed.oldPath ? { oldPath: placed.oldPath } : {}), body: findingBody(f, placed.ref) });
  }
  return { summary: reply.summary, comments, loose };
}

/** The summary as posted: the reviewer's words, how many findings are on the code, then the ones that are not. */
export const summaryWith = (summary: string, onCode: number, loose: readonly string[]): string => [summary, onCode > 0 && (summary || loose.length > 0) ? onTheCodeLine(onCode) : null, ...loose].filter(Boolean).join('\n\n');

/** The summary with every comment on a line written under it, for a host or a case that cannot take them on lines. */
export function foldComments(summary: string, comments: readonly ReviewLineComment[]): string {
  if (comments.length === 0) return summary;
  return [summary, ...comments.map((c) => `**${c.path}:${c.start !== undefined ? `${c.start}–` : ''}${c.line}**\n${c.body}`)].join('\n\n');
}

/**
 * Said to the agent wherever post_review is described or answered: the review card is the last
 * thing in its turn (Matt, 2026-11-21: a review that was followed by "I've reviewed the PR and
 * handed you the review" and more). The transcript keeps the card last all the same (`reviewLast`).
 */
export const REVIEW_ENDS_TURN = 'The review card is the last thing in this turn: end your turn now and write nothing after it, not even to say that the review is done.';
/** The same, before the call: in the first message of a review and in the tool's description. */
export const REVIEW_IS_LAST = 'post_review is the last thing you do in the turn. Anything the user should know goes in its summary or is said before the call; after it, end your turn without writing anything more, not even to say that the review is done.';
