// A review of somebody else's pull request, as the agent hands it over with `post_review` and as
// it is posted: a verdict, a summary, and comments on lines. It is a card in the conversation;
// nothing reaches the host until the user posts it (or chose "Review and reply on their own").
// Pure and browser-safe.

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

export interface ReviewReply {
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewLineComment[];
  /** The commit the review is of: the session's review mark when the agent handed it over. */
  sha: string;
  /** Set once it reached the host. */
  posted?: ReviewPosted;
}

export interface ReviewPosted {
  at: number;
  verdict: ReviewVerdict;
  /** True when Kestrel posted it without the user's click (the setting's fourth choice). */
  onItsOwn?: boolean;
  /** Something the user should know about how it went up: comments folded into the summary, say. */
  note?: string;
}

export const SUMMARY_MAX = 20_000;
export const COMMENT_MAX = 5_000;
export const COMMENTS_MAX = 50;

const isVerdict = (v: unknown): v is ReviewVerdict => REVIEW_VERDICTS.includes(v as ReviewVerdict);

/** A summary as given, or why it will not do. */
export function summaryProblem(summary: unknown): string | null {
  if (typeof summary !== 'string' || !summary.trim()) return 'summary is empty. Say what the change does and what you found.';
  if (summary.length > SUMMARY_MAX) return `summary is longer than ${SUMMARY_MAX} characters.`;
  return null;
}

export const verdictProblem = (verdict: unknown): string | null => (isVerdict(verdict) ? null : `verdict must be one of: ${REVIEW_VERDICTS.join(', ')}.`);

/** What `post_review` was given, checked: the review, or the reason it is not one. */
export function draftReview(args: { verdict?: unknown; summary?: unknown; comments?: unknown }, sha: string): { reply: ReviewReply } | { problem: string } {
  const problem = verdictProblem(args.verdict) ?? summaryProblem(args.summary);
  if (problem) return { problem };
  const given = args.comments === undefined || args.comments === null ? [] : args.comments;
  if (!Array.isArray(given)) return { problem: 'comments must be a list of { path, line, body }.' };
  if (given.length > COMMENTS_MAX) return { problem: `At most ${COMMENTS_MAX} comments on lines. Put the rest in the summary.` };
  const comments: ReviewLineComment[] = [];
  for (const [i, raw] of given.entries()) {
    const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const path = typeof c.path === 'string' ? c.path.trim().replace(/^\.\//, '') : '';
    const body = typeof c.body === 'string' ? c.body.trim() : '';
    if (!path || path.startsWith('/') || path.split('/').includes('..')) return { problem: `Comment ${i + 1}: path must be a file relative to the repository.` };
    if (typeof c.line !== 'number' || !Number.isInteger(c.line) || c.line < 1) return { problem: `Comment ${i + 1}: line must be a line number, 1 or more.` };
    if (!body) return { problem: `Comment ${i + 1}: body is empty.` };
    if (body.length > COMMENT_MAX) return { problem: `Comment ${i + 1}: body is longer than ${COMMENT_MAX} characters.` };
    comments.push({ path, line: c.line, body });
  }
  return { reply: { verdict: args.verdict as ReviewVerdict, summary: (args.summary as string).trim(), comments, sha } };
}

/** The summary with every comment on a line written under it, for a host or a case that cannot take them on lines. */
export function foldComments(summary: string, comments: readonly ReviewLineComment[]): string {
  if (comments.length === 0) return summary;
  return [summary, ...comments.map((c) => `**${c.path}:${c.line}**\n${c.body}`)].join('\n\n');
}
