// A review of somebody else's pull request, as the agent hands it over with `post_review` and as
// it is posted: a verdict, a short summary, and findings (0.0.23; Matt, 2026-11-21). A finding is
// one problem, said once: a brief anyone can read, a technical explanation that starts folded, a
// suggested fix, a priority, whether the agent thinks it blocks the merge, and the lines of code it
// is about. The user may change any of it and dismiss any finding before posting; what is kept goes
// to the host as comments on lines. It is a card in the conversation; nothing reaches the host
// until the user posts it (or chose "Review and reply on their own"). Pure and browser-safe.

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
  /** The file, relative to the repository. */
  path: string;
  /** The line in the file as the request leaves it. */
  line: number;
  body: string;
}

export type FindingPriority = 'high' | 'medium' | 'low';
export const FINDING_PRIORITIES: readonly FindingPriority[] = ['high', 'medium', 'low'];
export const PRIORITY_LABEL: Record<FindingPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** A line of code a finding is about. */
export interface FindingRef {
  path: string;
  line: number;
}

/** One problem the review found. */
export interface ReviewFinding {
  /** Its name within the review: f1, f2, … Never changes, so an edit says which one it is of. */
  id: string;
  /** One or two plain sentences: what is wrong. Always shown. */
  brief: string;
  /** The technical explanation: why, precisely enough for an engineer (or a model) to act on. Folded until asked for. */
  detail?: string;
  /** What to do instead. */
  fix?: string;
  priority: FindingPriority;
  /** The agent's opinion (or the user's, once they change it) that this must be fixed before the change merges. */
  blocking: boolean;
  /** The lines it is about; the first is where its comment is posted. None: it is written under the summary. */
  refs: FindingRef[];
  /** The user took it out of the review: kept on the card, not posted. */
  dismissed?: boolean;
}

export interface ReviewReply {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  /** The commit the review is of: the session's review mark when the agent handed it over. */
  sha: string;
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
}

export const SUMMARY_MAX = 20_000;
export const BRIEF_MAX = 600;
export const DETAIL_MAX = 5_000;
export const FIX_MAX = 2_000;
export const FINDINGS_MAX = 50;
export const REFS_MAX = 5;

const isVerdict = (v: unknown): v is ReviewVerdict => REVIEW_VERDICTS.includes(v as ReviewVerdict);
const isPriority = (v: unknown): v is FindingPriority => FINDING_PRIORITIES.includes(v as FindingPriority);

/** A summary as given, or why it will not do. */
export function summaryProblem(summary: unknown, allowEmpty = false): string | null {
  if (typeof summary !== 'string' || (!allowEmpty && !summary.trim())) return 'summary is empty. Say what the change does and what you make of it.';
  if (summary.length > SUMMARY_MAX) return `summary is longer than ${SUMMARY_MAX} characters.`;
  return null;
}

export const verdictProblem = (verdict: unknown): string | null => (isVerdict(verdict) ? null : `verdict must be one of: ${REVIEW_VERDICTS.join(', ')}.`);

const optionalText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Findings as given (by the agent, or by the user's edits), checked: the list, or the reason it is
 * not one. `ids` names each finding when the caller already has names for them (an edit keeps the
 * card's own); otherwise they are numbered.
 */
export function checkFindings(given: unknown, ids?: readonly string[]): { findings: ReviewFinding[] } | { problem: string } {
  if (given === undefined || given === null) return { findings: [] };
  if (!Array.isArray(given)) return { problem: 'findings must be a list.' };
  if (given.length > FINDINGS_MAX) return { problem: `At most ${FINDINGS_MAX} findings. Keep the ones that matter most.` };
  const findings: ReviewFinding[] = [];
  for (const [i, raw] of given.entries()) {
    const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const at = `Finding ${i + 1}`;
    const brief = optionalText(f.brief);
    const detail = optionalText(f.detail);
    const fix = optionalText(f.fix);
    if (!brief) return { problem: `${at}: brief is empty. Say in a sentence or two what is wrong.` };
    if (brief.length > BRIEF_MAX) return { problem: `${at}: brief is longer than ${BRIEF_MAX} characters. Keep it to a sentence or two; the rest goes in detail.` };
    if (detail.length > DETAIL_MAX) return { problem: `${at}: detail is longer than ${DETAIL_MAX} characters.` };
    if (fix.length > FIX_MAX) return { problem: `${at}: fix is longer than ${FIX_MAX} characters.` };
    if (!isPriority(f.priority)) return { problem: `${at}: priority must be one of: ${FINDING_PRIORITIES.join(', ')}.` };
    if (typeof f.blocking !== 'boolean') return { problem: `${at}: blocking must be true or false.` };
    const givenRefs = f.refs === undefined || f.refs === null ? [] : f.refs;
    if (!Array.isArray(givenRefs)) return { problem: `${at}: refs must be a list of { path, line }.` };
    if (givenRefs.length > REFS_MAX) return { problem: `${at}: at most ${REFS_MAX} code references.` };
    const refs: FindingRef[] = [];
    for (const rawRef of givenRefs) {
      const r = (typeof rawRef === 'object' && rawRef !== null ? rawRef : {}) as Record<string, unknown>;
      const path = typeof r.path === 'string' ? r.path.trim().replace(/^\.\//, '') : '';
      if (!path || path.startsWith('/') || path.split('/').includes('..')) return { problem: `${at}: a reference's path must be a file relative to the repository.` };
      if (typeof r.line !== 'number' || !Number.isInteger(r.line) || r.line < 1) return { problem: `${at}: a reference's line must be a line number, 1 or more.` };
      refs.push({ path, line: r.line });
    }
    const id = ids?.[i] ?? (typeof f.id === 'string' && /^f\d+$/.test(f.id) ? f.id : `f${i + 1}`);
    findings.push({ id, brief, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}), priority: f.priority, blocking: f.blocking, refs, ...(f.dismissed === true ? { dismissed: true } : {}) });
  }
  return { findings };
}

/** What `post_review` was given, checked: the review, or the reason it is not one. */
export function draftReview(args: { verdict?: unknown; summary?: unknown; findings?: unknown }, sha: string): { reply: ReviewReply } | { problem: string } {
  const problem = verdictProblem(args.verdict);
  if (problem) return { problem };
  const checked = checkFindings(args.findings);
  if ('problem' in checked) return checked;
  const summaryError = summaryProblem(args.summary);
  if (summaryError) return { problem: summaryError };
  // As the agent hands it over nothing is dismissed, and each is named by its place.
  const findings = checked.findings.map(({ dismissed: _dropped, ...f }, i) => ({ ...f, id: `f${i + 1}` }));
  return { reply: { verdict: args.verdict as ReviewVerdict, summary: (args.summary as string).trim(), findings, sha } };
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
  const merged = own.map((f) => byId.get(f.id) ?? f);
  return checkFindings(merged, own.map((f) => f.id));
}

/** A review as it goes to a host: findings already turned into comments on lines (`postable`). */
export interface OutgoingReview {
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewLineComment[];
  sha: string;
}

/** The findings that will be posted: the ones not dismissed. */
export const keptFindings = (findings: readonly ReviewFinding[]): ReviewFinding[] => findings.filter((f) => !f.dismissed);

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
/** The kept findings marked blocking: approving over any of them is confirmed first (the card's dialog). */
export const blockingFindings = (findings: readonly ReviewFinding[]): ReviewFinding[] => keptFindings(findings).filter((f) => f.blocking);

export function verdictFor(agentVerdict: ReviewVerdict, findings: readonly ReviewFinding[]): ReviewVerdict {
  if (blockingFindings(findings).length > 0) return 'request_changes';
  return agentVerdict === 'request_changes' ? 'comment' : agentVerdict;
}

const PRIORITY_ORDER: Record<FindingPriority, number> = { high: 0, medium: 1, low: 2 };

/** Blocking first, then by priority; findings that tie keep the agent's order. */
export function orderFindings<T extends Pick<ReviewFinding, 'blocking' | 'priority'>>(findings: readonly T[]): T[] {
  return findings.map((f, i) => ({ f, i })).sort((a, b) => Number(b.f.blocking) - Number(a.f.blocking) || PRIORITY_ORDER[a.f.priority] - PRIORITY_ORDER[b.f.priority] || a.i - b.i).map(({ f }) => f);
}

/** "Blocking · High priority" / "Medium priority": how a finding is marked where it is posted and on its card. */
export const findingMark = (f: Pick<ReviewFinding, 'blocking' | 'priority'>): string => `${f.blocking ? 'Blocking · ' : ''}${PRIORITY_LABEL[f.priority]} priority`;

/** A finding as one comment: its mark, the brief, then the explanation, the fix and any further lines it names. */
export function findingBody(f: ReviewFinding): string {
  const also = f.refs.slice(1);
  return [
    `**${findingMark(f)}.** ${f.brief}`,
    f.detail,
    f.fix ? `**Suggested fix:** ${f.fix}` : undefined,
    also.length > 0 ? `Also: ${also.map((r) => `\`${r.path}:${r.line}\``).join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What goes to the host for a review's kept findings: a comment on the first line each names, and
 * the ones that name no line written under the summary. Blocking and high priority first. Nothing
 * at all when the approval goes up without comment.
 */
export function postable(reply: Pick<ReviewReply, 'summary' | 'findings'>, withoutComment = false): { summary: string; comments: ReviewLineComment[] } {
  // "Approve without comment": the approval alone. The summary and the findings stay on the card.
  if (withoutComment) return { summary: '', comments: [] };
  const kept = orderFindings(keptFindings(reply.findings));
  const comments = kept.flatMap((f) => (f.refs[0] ? [{ path: f.refs[0].path, line: f.refs[0].line, body: findingBody(f) }] : []));
  const loose = kept.filter((f) => f.refs.length === 0).map(findingBody);
  return { summary: [reply.summary, ...loose].join('\n\n'), comments };
}

/** The summary with every comment on a line written under it, for a host or a case that cannot take them on lines. */
export function foldComments(summary: string, comments: readonly ReviewLineComment[]): string {
  if (comments.length === 0) return summary;
  return [summary, ...comments.map((c) => `**${c.path}:${c.line}**\n${c.body}`)].join('\n\n');
}

/**
 * Said to the agent wherever post_review is described or answered: the review card is the last
 * thing in its turn (Matt, 2026-11-21: a review that was followed by "I've reviewed the PR and
 * handed you the review" and more). The transcript keeps the card last all the same (`reviewLast`).
 */
export const REVIEW_ENDS_TURN = 'The review card is the last thing in this turn: end your turn now and write nothing after it, not even to say that the review is done.';
/** The same, before the call: in the first message of a review and in the tool's description. */
export const REVIEW_IS_LAST = 'post_review is the last thing you do in the turn. Anything the user should know goes in its summary or is said before the call; after it, end your turn without writing anything more, not even to say that the review is done.';
