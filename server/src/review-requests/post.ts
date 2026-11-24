// Posting a review to the host, with the host's own command-line tool, from the review session's
// worktree, as one act with its verdict. Which findings go on the code was decided before posting
// from the reviewed commit's diff (shared/diff-anchors.ts); the rest are written under the summary.
//
// GitHub takes the whole review in one call (the reviews API) on the commit that was reviewed, with
// its comments on their lines (a range as start_line and line). If it refuses the lines after all,
// the review goes up again with those comments written under the summary, and the card says so.
//
// GitLab has no single call, but it has drafts: each comment on the code becomes a draft note with a
// position on the reviewed commit's diff, the summary another draft, and one bulk publish puts them
// all up together, so the author is told once. A draft GitLab refuses goes under the summary. When
// the merge request has new commits, the positions would be on code that moved, so everything goes
// under the summary. An approval is `glab mr approve --sha`, made first: the server refuses it when
// the head is no longer that commit, and then nothing at all is posted. Asking for changes on GitLab
// is a note that says so. The command runner is injected: tests never call gh or glab.
import { ghFailureReason, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { postedSummary, withFolded, type OutgoingReview, type ReviewLineComment } from '../shared/review-reply.ts';
import { Refused } from '../workspace.ts';

const GH_EVENT = { comment: 'COMMENT', approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' } as const;

/** `gh api` arguments that post a review of pull request `number` in the repository of the working folder. Pure. */
export function ghReviewArgs(number: number, reply: OutgoingReview): string[] {
  const comments = reply.comments.flatMap((c) => [
    '-f', `comments[][path]=${c.path}`,
    ...(c.start !== undefined ? ['-F', `comments[][start_line]=${c.start}`, '-f', 'comments[][start_side]=RIGHT'] : []),
    '-F', `comments[][line]=${c.line}`,
    '-f', 'comments[][side]=RIGHT',
    '-f', `comments[][body]=${c.body}`,
  ]);
  const summary = postedSummary(reply);
  return ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '-f', `commit_id=${reply.sha}`, '-f', `event=${GH_EVENT[reply.verdict]}`, ...(summary ? ['-f', `body=${summary}`] : []), ...comments];
}

export const glabNoteArgs = (number: number, body: string): string[] => ['mr', 'note', String(number), `--message=${body}`];
export const glabApproveArgs = (number: number, sha: string): string[] => ['mr', 'approve', String(number), '--sha', sha];
export const glabRequestArgs = (number: number): string[] => ['api', `projects/:id/merge_requests/${number}`];
const drafts = (number: number) => `projects/:id/merge_requests/${number}/draft_notes`;

/** The diff versions GitLab positions a comment against. */
export interface DiffRefs {
  base: string;
  start: string;
  head: string;
}

/** `glab api` arguments for a draft note on a line of the merge request's diff. Pure. */
export function glabDraftArgs(number: number, c: ReviewLineComment, refs: DiffRefs): string[] {
  return [
    'api', '-X', 'POST', drafts(number),
    '-f', `note=${c.body}`,
    '-f', 'position[position_type]=text',
    '-f', `position[base_sha]=${refs.base}`,
    '-f', `position[start_sha]=${refs.start}`,
    '-f', `position[head_sha]=${refs.head}`,
    '-f', `position[old_path]=${c.oldPath ?? c.path}`,
    '-f', `position[new_path]=${c.path}`,
    '-F', `position[new_line]=${c.line}`,
    ...(c.oldLine ? ['-F', `position[old_line]=${c.oldLine}`] : []),
  ];
}

export const glabSummaryDraftArgs = (number: number, body: string): string[] => ['api', '-X', 'POST', drafts(number), '-f', `note=${body}`];
export const glabPublishArgs = (number: number): string[] => ['api', '-X', 'POST', `${drafts(number)}/bulk_publish`];
export const glabDeleteDraftArgs = (number: number, id: number): string[] => ['api', '-X', 'DELETE', `${drafts(number)}/${id}`];

/** What a GitLab note says: the verdict it cannot carry any other way, then the review. Pure. */
export function gitlabNote(reply: Pick<OutgoingReview, 'verdict' | 'summary' | 'comments' | 'loose'>): string {
  const body = postedSummary(reply);
  return reply.verdict === 'request_changes' ? `**Changes requested.**\n\n${body}` : body;
}

const stderrOf = (error: unknown): string => (typeof (error as { stderr?: unknown } | null)?.stderr === 'string' ? (error as { stderr: string }).stderr : '');
/** GitHub's answer when a comment's line is not part of the diff (HTTP 422). */
const LINES_REFUSED = /\b422\b|unprocessable|could not be resolved|pull_request_review_thread/i;

/** GitLab's diff versions for a merge request, from `glab api`'s answer; null when it gave none. Pure. */
export function diffRefsOf(stdout: string): DiffRefs | null {
  try {
    const refs = (JSON.parse(stdout) as { diff_refs?: Record<string, unknown> }).diff_refs;
    const { base_sha: base, start_sha: start, head_sha: head } = refs ?? {};
    return typeof base === 'string' && typeof start === 'string' && typeof head === 'string' ? { base, start, head } : null;
  } catch {
    return null;
  }
}

const idOf = (stdout: string): number | null => {
  try {
    const id = (JSON.parse(stdout) as { id?: unknown }).id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
};

export interface PostReviewTarget {
  host: HostKind;
  number: number;
  /** The review session's worktree: where gh and glab work out the repository. */
  cwd: string;
}

/** How a review went up when it differs from how it was written. */
export interface PostOutcome {
  /** For the user, or null. */
  note: string | null;
  /** Findings that went under the summary although their line was in the diff, by id, with why. */
  moved: Record<string, string>;
}

const movedAll = (comments: readonly ReviewLineComment[], why: string): Record<string, string> => Object.fromEntries(comments.flatMap((c) => (c.findingId ? [[c.findingId, why]] : [])));

/** Post the review. Resolves with how it went up; throws `Refused` with the host's reason when nothing was posted. */
export async function postReview(run: CommandRunner, target: PostReviewTarget, reply: OutgoingReview): Promise<PostOutcome> {
  return target.host === 'github' ? postToGitHub(run, target, reply) : postToGitLab(run, target, reply);
}

async function postToGitHub(run: CommandRunner, target: PostReviewTarget, reply: OutgoingReview): Promise<PostOutcome> {
  const gh = (args: string[]) => run('gh', args, { cwd: target.cwd, timeoutMs: GH_TIMEOUT_MS });
  try {
    await gh(ghReviewArgs(target.number, reply));
    return { note: null, moved: {} };
  } catch (error) {
    if (reply.comments.length === 0 || !LINES_REFUSED.test(stderrOf(error))) throw new Refused(`GitHub did not take the review: ${ghFailureReason(error)}`);
  }
  // GitHub answers for the review as a whole, not per comment: all of them go under the summary.
  try {
    await gh(ghReviewArgs(target.number, withFolded(reply, reply.comments)));
    return { note: 'GitHub would not place the comments on their lines, so they are written under the summary.', moved: movedAll(reply.comments, 'GitHub would not take a comment on its line') };
  } catch (error) {
    throw new Refused(`GitHub did not take the review: ${ghFailureReason(error)}`);
  }
}

async function postToGitLab(run: CommandRunner, target: PostReviewTarget, reply: OutgoingReview): Promise<PostOutcome> {
  const glab = (args: string[]) => run('glab', args, { cwd: target.cwd, timeoutMs: GLAB_TIMEOUT_MS });
  const failed = (error: unknown) => new Refused(`GitLab did not take the review: ${glabFailureReason(error)}`);
  // The approval first: if the head has moved it is refused, and then nothing at all is posted.
  if (reply.verdict === 'approve') await glab(glabApproveArgs(target.number, reply.sha)).catch((error: unknown) => Promise.reject(failed(error)));
  if (reply.comments.length === 0) return postNote(glab, target.number, reply, failed, { note: null, moved: {} });
  const refs = await glab(glabRequestArgs(target.number)).then((out) => diffRefsOf(out.stdout), () => null);
  if (!refs || refs.head !== reply.sha) {
    const why = refs ? 'the merge request has new commits since the review, so its line may have moved' : 'GitLab did not say which commits the merge request compares';
    return postNote(glab, target.number, withFolded(reply, reply.comments), failed, { note: `The comments are written under the summary: ${why}.`, moved: movedAll(reply.comments, why) });
  }
  const made: number[] = [];
  const refused: ReviewLineComment[] = [];
  for (const c of reply.comments) {
    try {
      const id = idOf((await glab(glabDraftArgs(target.number, c, refs))).stdout);
      if (id !== null) made.push(id);
    } catch {
      refused.push(c);
    }
  }
  const out = withFolded(reply, refused);
  try {
    const note = gitlabNote(out);
    if (note.trim()) await glab(glabSummaryDraftArgs(target.number, note));
    await glab(glabPublishArgs(target.number));
  } catch (error) {
    // Nothing went up: take the drafts back so they do not wait in the user's name.
    for (const id of made) await glab(glabDeleteDraftArgs(target.number, id)).catch(() => undefined);
    throw failed(error);
  }
  const why = 'GitLab would not take a comment on its line';
  return refused.length > 0 ? { note: `GitLab would not place ${refused.length === 1 ? 'one comment' : `${refused.length} comments`} on its line, so ${refused.length === 1 ? 'it is' : 'they are'} written under the summary.`, moved: movedAll(refused, why) } : { note: null, moved: {} };
}

async function postNote(glab: (args: string[]) => Promise<unknown>, number: number, reply: OutgoingReview, failed: (error: unknown) => Refused, outcome: PostOutcome): Promise<PostOutcome> {
  const note = gitlabNote(reply);
  try {
    if (note.trim()) await glab(glabNoteArgs(number, note));
  } catch (error) {
    throw failed(error);
  }
  return outcome;
}
