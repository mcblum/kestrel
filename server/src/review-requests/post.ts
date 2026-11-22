// Posting a review to the host, with the host's own command-line tool, from the review session's
// worktree. GitHub takes the whole review in one call (the reviews API), on the commit that was
// reviewed, with its comments on lines; if it refuses the lines (one is outside the diff) the
// review goes up again with them written under the summary. GitLab has no single call: the
// summary and comments go up as one note, and an approval is `glab mr approve --sha`, which the
// server refuses when the head is no longer that commit. Asking for changes on GitLab is a note
// that says so. The command runner is injected: tests never call gh or glab.
import { ghFailureReason, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { foldComments, type OutgoingReview } from '../shared/review-reply.ts';
import { Refused } from '../workspace.ts';

const GH_EVENT = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' } as const;

/** `gh api` arguments that post a review of pull request `number` in the repository of the working folder. Pure. */
export function ghReviewArgs(number: number, reply: OutgoingReview): string[] {
  const comments = reply.comments.flatMap((c) => ['-f', `comments[][path]=${c.path}`, '-F', `comments[][line]=${c.line}`, '-f', 'comments[][side]=RIGHT', '-f', `comments[][body]=${c.body}`]);
  return ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '-f', `commit_id=${reply.sha}`, '-f', `event=${GH_EVENT[reply.verdict]}`, ...(reply.summary ? ['-f', `body=${reply.summary}`] : []), ...comments];
}

export const glabNoteArgs = (number: number, body: string): string[] => ['mr', 'note', String(number), `--message=${body}`];
export const glabApproveArgs = (number: number, sha: string): string[] => ['mr', 'approve', String(number), '--sha', sha];

/** What a GitLab note says: the verdict it cannot carry any other way, then the review. Pure. */
export function gitlabNote(reply: Pick<OutgoingReview, 'verdict' | 'summary' | 'comments'>): string {
  const body = foldComments(reply.summary, reply.comments);
  return reply.verdict === 'request_changes' ? `**Changes requested.**\n\n${body}` : body;
}

const stderrOf = (error: unknown): string => (typeof (error as { stderr?: unknown } | null)?.stderr === 'string' ? (error as { stderr: string }).stderr : '');
/** GitHub's answer when a comment's line is not part of the diff (HTTP 422). */
const LINES_REFUSED = /\b422\b|unprocessable|could not be resolved|pull_request_review_thread/i;

export interface PostReviewTarget {
  host: HostKind;
  number: number;
  /** The review session's worktree: where gh and glab work out the repository. */
  cwd: string;
}

/**
 * Post the review. Resolves with a note for the user when it went up differently from how it was
 * written, else null. Throws `Refused` with the host's reason when nothing was posted.
 */
export async function postReview(run: CommandRunner, target: PostReviewTarget, reply: OutgoingReview): Promise<string | null> {
  if (target.host === 'github') {
    const gh = (args: string[]) => run('gh', args, { cwd: target.cwd, timeoutMs: GH_TIMEOUT_MS });
    try {
      await gh(ghReviewArgs(target.number, reply));
      return null;
    } catch (error) {
      if (reply.comments.length === 0 || !LINES_REFUSED.test(stderrOf(error))) throw new Refused(`GitHub did not take the review: ${ghFailureReason(error)}`);
    }
    try {
      await gh(ghReviewArgs(target.number, { ...reply, summary: foldComments(reply.summary, reply.comments), comments: [] }));
      return 'GitHub would not place the comments on their lines (one is outside the change), so they are written under the summary.';
    } catch (error) {
      throw new Refused(`GitHub did not take the review: ${ghFailureReason(error)}`);
    }
  }
  const glab = (args: string[]) => run('glab', args, { cwd: target.cwd, timeoutMs: GLAB_TIMEOUT_MS });
  try {
    // The approval first: if the head has moved it is refused, and then nothing at all is posted.
    if (reply.verdict === 'approve') await glab(glabApproveArgs(target.number, reply.sha));
    const note = gitlabNote(reply);
    if (note.trim()) await glab(glabNoteArgs(target.number, note));
  } catch (error) {
    throw new Refused(`GitLab did not take the review: ${glabFailureReason(error)}`);
  }
  return reply.comments.length > 0 ? 'GitLab takes a review as one note, so the comments on lines are written under the summary.' : null;
}
