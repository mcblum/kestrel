// GitLab merge requests through the `glab` CLI, mapped onto the same PullRequest shape GitHub's use.
// The list (`glab mr list --source-branch <b> --all --output json`) has no pipeline, so each open or
// draft one is viewed too (`glab mr view <iid> --output json`) for `head_pipeline.status`. Review and
// readiness come from `detailed_merge_status` alone: no extra calls for approvals. When that pipeline
// failed, its failed jobs are asked for once (`glab api …/pipelines/<id>/jobs?scope[]=failed`, then its
// failed trigger jobs when there are none, for a child pipeline), and so are the commit's statuses
// (`…/repository/commits/<sha>/statuses`), for a status another service reported into the request
// (Jenkins, for one), which the jobs list does not include and which links to that service's page. Both
// are kept for as long as the pipeline is unchanged, so a request polled every few seconds costs two
// calls per failed pipeline. Conflicts come
// with the view (`has_conflicts`, `detailed_merge_status`). Whether a reviewer asked for changes is in
// `detailed_merge_status` only while nothing else blocks the merge (a conflict or a failed pipeline
// hides it), so each open one's reviewers are asked too (`…/merge_requests/<iid>/reviewers`), once per
// change to the merge request (its `updated_at` and head), and, only when one asked for changes, its
// discussions, for what they said (`reviewLookup`). While Autopilot watches the target branch after a
// merge, the pipelines for the merge's commit on that branch are asked for (`pipelineOn`), and a failed
// one's jobs as for a request. Also GitLab's
// commands for creating one (`gitlabCommands`). The runner is injected: tests never call glab.
import { clipReviewText, REVIEW_COMMENTS_KEPT, type BasePipeline, type ChangesRequest, type ChecksState, type FailedCheck, type MergeReadiness, type PullRequest, type PullRequestState, type ReviewComment, type ReviewState } from '../shared/details.ts';
import { ready, reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';
import { execRunner } from './github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from './glab.ts';
import type { CommandRunner, HostCommands, PipelineProvider, PullRequestProvider } from './types.ts';

type Fields = Record<string, unknown>;

const PIPELINE_RUNNING = new Set(['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled', 'manual', 'waiting_for_callback']);
const PIPELINE_FAILED = new Set(['failed', 'canceled', 'canceling']);
/** detailed_merge_status values that are GitLab still working it out, or nothing to say. */
const STATUS_UNKNOWN = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing', 'not_open', '']);

/** A pipeline status (`head_pipeline.status`) as checks; no pipeline is none. Pure. */
export function pipelineChecks(status: unknown): ChecksState {
  if (typeof status !== 'string' || !status) return 'none';
  if (status === 'success') return 'passing';
  if (PIPELINE_FAILED.has(status)) return 'failing';
  if (PIPELINE_RUNNING.has(status)) return 'running';
  return 'none'; // skipped, or a status GitLab adds later
}

/** `detailed_merge_status` (and `has_conflicts`) in neutral words; ready only on GitLab's own "mergeable". Pure. */
export function gitlabReadiness(status: unknown, hasConflicts: unknown): MergeReadiness {
  if (hasConflicts === true || status === 'conflict') return 'conflicts';
  if (status === 'mergeable') return 'ready';
  if (status === 'need_rebase') return 'behind';
  if (typeof status !== 'string' || STATUS_UNKNOWN.has(status)) return 'unknown';
  return 'blocked'; // ci_must_pass, discussions_not_resolved, not_approved, blocked_status, …
}

/** Review from `detailed_merge_status`: GitLab says only "needs approval" or "changes requested" there. Pure. */
export function gitlabReview(status: unknown): ReviewState {
  if (status === 'not_approved') return 'review-required';
  if (status === 'requested_changes') return 'changes-requested';
  return 'none';
}

function stateOf(state: unknown, draft: unknown): PullRequestState {
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  return draft === true ? 'draft' : 'open'; // opened, or locked while GitLab merges it
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const isActive = (pr: PullRequest) => pr.state === 'open' || pr.state === 'draft';

/** One merge request (a list item, or the fuller single view) as a pull request. Pure. */
export function mapGlabMergeRequest(mr: Fields): PullRequest {
  const author = mr.author && typeof mr.author === 'object' ? text((mr.author as Fields).username) : undefined;
  const pipeline = (mr.head_pipeline ?? mr.pipeline) as Fields | null | undefined;
  const readiness = gitlabReadiness(mr.detailed_merge_status, mr.has_conflicts);
  const state = stateOf(mr.state, mr.draft);
  // The commit the merge put on the target branch: its merge commit, else its squash commit, else (a fast-forward) the head.
  const mergeSha = state === 'merged' ? (text(mr.merge_commit_sha) || text(mr.squash_commit_sha) || text(mr.sha)) : undefined;
  return {
    ...(mergeSha ? { mergeSha } : {}),
    ...(text(mr.sha) ? { headSha: text(mr.sha) } : {}),
    ...(pipeline && typeof pipeline.web_url === 'string' && /^https:\/\//.test(pipeline.web_url) ? { checksUrl: pipeline.web_url } : {}),
    ...(text(mr.description) !== undefined ? { body: text(mr.description) } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(text(mr.source_branch) !== undefined ? { headBranch: text(mr.source_branch) } : {}),
    ...(text(mr.target_branch) !== undefined ? { baseBranch: text(mr.target_branch) } : {}),
    ...(readiness !== 'unknown' ? { readiness } : {}),
    number: mr.iid as number,
    title: typeof mr.title === 'string' ? mr.title : `!${String(mr.iid)}`,
    state,
    checks: pipelineChecks(pipeline && typeof pipeline === 'object' ? pipeline.status : undefined),
    review: gitlabReview(mr.detailed_merge_status),
    url: typeof mr.web_url === 'string' && /^https:\/\//.test(mr.web_url) ? mr.web_url : '',
  };
}

const hasIid = (mr: unknown): mr is Fields => typeof mr === 'object' && mr !== null && Number.isInteger((mr as Fields).iid) && ((mr as Fields).iid as number) >= 0;

/** `glab mr list --output json` as merge-request objects. Throws when it is not a list. Pure. */
export function parseGlabList(json: string): Fields[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list');
  return parsed.filter(hasIid);
}

export const listArgs = (branch: string): string[] => ['mr', 'list', `--source-branch=${branch}`, '--all', '--output', 'json'];
export const viewArgs = (iid: number): string[] => ['mr', 'view', String(iid), '--output', 'json'];

type FailedJobs = ReturnType<typeof failedJobsLookup>;
type Reviews = ReturnType<typeof reviewLookup>;

/**
 * One list item with its single view, for the pipeline; the view wins where both say something. A
 * failed pipeline's jobs are added, and who asked for changes.
 */
async function withView(run: CommandRunner, failedJobs: FailedJobs, reviews: Reviews, cwd: string, item: Fields): Promise<PullRequest> {
  const listed = mapGlabMergeRequest(item);
  if (!isActive(listed)) return listed;
  const { stdout } = await run('glab', viewArgs(listed.number), { cwd, timeoutMs: GLAB_TIMEOUT_MS });
  const view: unknown = JSON.parse(stdout);
  if (!hasIid(view)) throw new Error(`glab gave no merge request for !${listed.number}`);
  const merged = { ...item, ...view };
  const pr = mapGlabMergeRequest(merged);
  const pipeline = (merged.head_pipeline ?? merged.pipeline) as Fields | null | undefined;
  const failed = pr.checks === 'failing' && pipeline && typeof pipeline === 'object' ? await failedJobs(cwd, pipeline) : null;
  const asked = await reviews(cwd, merged);
  // The reviewers' own state wins; where glab could not say (or names nobody), the merge status stands.
  const review: ReviewState = asked ? 'changes-requested' : pr.review;
  return { ...pr, review, ...(failed ? { failedChecks: failed } : {}), ...(asked ? { changesRequested: asked } : {}) };
}

export const reviewersArgs = (iid: number): string[] => ['api', `projects/:id/merge_requests/${iid}/reviewers`];
export const discussionsArgs = (iid: number): string[] => ['api', `projects/:id/merge_requests/${iid}/discussions?per_page=100`];

/** The reviewers whose state is "requested changes", from `…/reviewers`. Pure. */
export function reviewersAskingOf(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list of reviewers');
  return parsed
    .filter((r): r is Fields => typeof r === 'object' && r !== null && r.state === 'requested_changes')
    .map((r) => (r.user && typeof r.user === 'object' ? text((r.user as Fields).username) : undefined) ?? 'A reviewer');
}

/**
 * What the asking reviewers said: their notes that are not system notes and not resolved, oldest
 * first. The newest one's id names the occurrence and its link is the review's. Pure.
 */
export function changesFromDiscussions(reviewers: string[], json: string, mrUrl: string): ChangesRequest {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list of discussions');
  const who = new Set(reviewers);
  const notes = parsed
    .flatMap((d) => (typeof d === 'object' && d !== null && Array.isArray((d as Fields).notes) ? ((d as Fields).notes as unknown[]) : []))
    .filter((n): n is Fields => typeof n === 'object' && n !== null)
    .filter((n) => n.system !== true && n.resolved !== true && typeof n.body === 'string' && typeof n.id === 'number' && who.has(String((n.author as Fields | undefined)?.username)));
  const newest = notes.reduce<Fields | null>((a, n) => (!a || (n.id as number) > (a.id as number) ? n : a), null);
  const noteUrl = (id: unknown) => (mrUrl ? `${mrUrl}#note_${String(id)}` : undefined);
  const comments: ReviewComment[] = notes.slice(0, REVIEW_COMMENTS_KEPT).map((n) => {
    const position = (n.position ?? {}) as Fields;
    const path = text(position.new_path) ?? text(position.old_path);
    const line = typeof position.new_line === 'number' ? position.new_line : typeof position.old_line === 'number' ? position.old_line : undefined;
    const url = noteUrl(n.id);
    return { body: clipReviewText(String(n.body)), ...(path ? { path } : {}), ...(line !== undefined && Number.isInteger(line) && line >= 0 ? { line } : {}), ...(url ? { url } : {}) };
  });
  const url = newest ? noteUrl(newest.id) : mrUrl || undefined;
  return { id: `${[...reviewers].sort().join(',')}@${newest ? String(newest.id) : '-'}`, reviewers, ...(url ? { url } : {}), comments };
}

/** How many merge requests' review answers are remembered. */
const REVIEWS_KEPT = 50;

/**
 * Who asked for changes on an open merge request, and what they said: asked once per change to the
 * merge request (its `updated_at` and head commit) and remembered. Undefined when nobody asks; null
 * when glab could not say (then `detailed_merge_status` is all there is).
 */
function reviewLookup(run: CommandRunner) {
  let kept: ReadonlyMap<string, ChangesRequest | undefined | null> = new Map();
  return async (cwd: string, mr: Fields): Promise<ChangesRequest | undefined | null> => {
    const iid = mr.iid as number;
    const key = `${cwd}\n${iid}\n${String(mr.updated_at ?? '')}\n${String(mr.sha ?? '')}`;
    if (kept.has(key)) return kept.get(key);
    let found: ChangesRequest | undefined | null;
    try {
      const ask = async (args: string[]) => (await run('glab', args, { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout;
      const reviewers = reviewersAskingOf(await ask(reviewersArgs(iid)));
      const mrUrl = typeof mr.web_url === 'string' && /^https:\/\//.test(mr.web_url) ? mr.web_url : '';
      found = reviewers.length === 0 ? undefined : changesFromDiscussions(reviewers, await ask(discussionsArgs(iid)), mrUrl);
    } catch {
      found = null;
    }
    const next = new Map(kept).set(key, found);
    kept = next.size > REVIEWS_KEPT ? new Map([...next].slice(-REVIEWS_KEPT)) : next;
    return found;
  };
}

const webUrl = (value: unknown): string | undefined => (typeof value === 'string' && /^https:\/\//.test(value) ? value : undefined);

/** A pipeline's failed jobs (or trigger jobs) as failed checks, leaving out the ones allowed to fail. Pure. */
export function failedJobsOf(json: string): FailedCheck[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list of jobs');
  return parsed
    .filter((j): j is Fields => typeof j === 'object' && j !== null && j.allow_failure !== true)
    .map((j) => {
      const name = (text(j.name) ?? '').trim() || 'A job';
      const downstream = j.downstream_pipeline && typeof j.downstream_pipeline === 'object' ? webUrl((j.downstream_pipeline as Fields).web_url) : undefined;
      const url = webUrl(j.web_url) ?? downstream;
      return url ? { name, url } : { name };
    });
}

export const failedJobsArgs = (pipelineId: number, kind: 'jobs' | 'bridges'): string[] => ['api', `projects/:id/pipelines/${pipelineId}/${kind}?scope[]=failed&per_page=100`];

/**
 * The commit's failed statuses that are not among `known` (by name), as failed checks: a status another
 * service reported (an external job, with its own `target_url`). A GitLab job is listed here as well, so
 * it is left to the jobs list; one allowed to fail, or still pending, running or skipped, is not a
 * failure. Pure.
 */
export function failedStatusesOf(json: string, known: readonly FailedCheck[]): FailedCheck[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list of commit statuses');
  const seen = new Set(known.map((c) => c.name));
  const out: FailedCheck[] = [];
  for (const st of parsed) {
    if (typeof st !== 'object' || st === null) continue;
    const f = st as Fields;
    if (f.status !== 'failed' || f.allow_failure === true) continue;
    const name = (text(f.name) ?? '').trim() || 'A status';
    if (seen.has(name)) continue;
    seen.add(name);
    const url = webUrl(f.target_url);
    out.push(url ? { name, url } : { name });
  }
  return out;
}

const SHA = /^[0-9a-f]{7,64}$/i;
export const statusesArgs = (sha: string): string[] => ['api', `projects/:id/repository/commits/${sha}/statuses?per_page=100`];

/** Kept per pipeline: how many pipelines' failed jobs are remembered. */
const FAILED_JOBS_KEPT = 50;

/**
 * The failed jobs of a failed pipeline, asked once per pipeline as it stands (its id, status and
 * update time) and remembered. Null when glab could not say: the request then shows the count it
 * has (none) and the pipeline's link.
 */
function failedJobsLookup(run: CommandRunner) {
  // The statuses another service reported; when glab cannot say, the pipeline's own jobs still stand.
  const externalStatuses = async (cwd: string, pipeline: Fields, own: FailedCheck[]): Promise<FailedCheck[]> => {
    const sha = text(pipeline.sha);
    if (!sha || !SHA.test(sha)) return [];
    try {
      return failedStatusesOf((await run('glab', statusesArgs(sha), { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout, own);
    } catch {
      return [];
    }
  };
  let kept: ReadonlyMap<string, FailedCheck[]> = new Map();
  return async (cwd: string, pipeline: Fields): Promise<FailedCheck[] | null> => {
    const id = pipeline.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) return null;
    const key = `${cwd}\n${id}\n${String(pipeline.status)}\n${String(pipeline.updated_at ?? '')}`;
    const known = kept.get(key);
    if (known) return known;
    try {
      const ask = async (kind: 'jobs' | 'bridges') => failedJobsOf((await run('glab', failedJobsArgs(id, kind), { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout);
      const jobs = await ask('jobs');
      const own = jobs.length > 0 ? jobs : await ask('bridges');
      const found = [...own, ...(await externalStatuses(cwd, pipeline, own))];
      const next = new Map(kept).set(key, found);
      kept = next.size > FAILED_JOBS_KEPT ? new Map([...next].slice(-FAILED_JOBS_KEPT)) : next;
      return found;
    } catch {
      return null;
    }
  };
}

export const pipelinesArgs = (sha: string, ref: string): string[] => ['api', `projects/:id/pipelines?sha=${sha}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}&per_page=20`];

/** The newest of the pipelines `…/pipelines?sha=` lists, or null when there is none yet. Pure. */
export function newestPipelineOf(json: string): Fields | null {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list of pipelines');
  const pipelines = parsed.filter((p): p is Fields => typeof p === 'object' && p !== null && Number.isInteger(p.id));
  return pipelines.reduce<Fields | null>((a, p) => (!a || (p.id as number) > (a.id as number) ? p : a), null);
}

const unreadable = (error: unknown) => `glab gave an answer Kestrel cannot read: ${reasonOf(error)}`;

export function gitlabProvider(run: CommandRunner = execRunner): PullRequestProvider & PipelineProvider {
  const failedJobs = failedJobsLookup(run);
  const reviews = reviewLookup(run);
  return {
    async pullRequestsFor(repoPath, branch): Promise<Sourced<PullRequest[]>> {
      let stdout: string;
      try {
        ({ stdout } = await run('glab', listArgs(branch), { cwd: repoPath, timeoutMs: GLAB_TIMEOUT_MS }));
      } catch (error) {
        return unavailable(glabFailureReason(error));
      }
      let items: Fields[];
      try {
        items = parseGlabList(stdout);
      } catch (error) {
        return unavailable(unreadable(error));
      }
      try {
        return ready(await Promise.all(items.map((item) => withView(run, failedJobs, reviews, repoPath, item))));
      } catch (error) {
        return unavailable(error instanceof SyntaxError ? unreadable(error) : glabFailureReason(error));
      }
    },
    async pipelineOn(repoPath, sha, ref): Promise<Sourced<BasePipeline>> {
      if (!SHA.test(sha)) return unavailable('That is not a commit id');
      let stdout: string;
      try {
        ({ stdout } = await run('glab', pipelinesArgs(sha, ref), { cwd: repoPath, timeoutMs: GLAB_TIMEOUT_MS }));
      } catch (error) {
        return unavailable(glabFailureReason(error));
      }
      let pipeline: Fields | null;
      try {
        pipeline = newestPipelineOf(stdout);
      } catch (error) {
        return unavailable(unreadable(error));
      }
      if (!pipeline) return ready({ sha, checks: 'none' });
      const checks = pipelineChecks(pipeline.status);
      const failed = checks === 'failing' ? await failedJobs(repoPath, { ...pipeline, sha }) : null;
      const url = typeof pipeline.web_url === 'string' && /^https:\/\//.test(pipeline.web_url) ? pipeline.web_url : undefined;
      return ready({ sha, checks, ...(failed ? { failedChecks: failed } : {}), ...(url ? { url } : {}) });
    },
  };
}

/** The new merge request's address in what `glab mr create` printed: the last web address. Pure. */
export function glabCreatedUrl(stdout: string): string {
  const urls = stdout.match(/https:\/\/\S+/g) ?? [];
  const mr = urls.filter((u) => /\/-\/merge_requests\/\d+/.test(u));
  return (mr.at(-1) ?? urls.at(-1) ?? stdout.trim().split('\n').at(-1) ?? '').trim();
}

/** Creating a merge request on GitLab through glab. */
export const gitlabCommands: HostCommands = {
  kind: 'gitlab',
  async defaultBranch(command) {
    const parsed = JSON.parse(await command('glab', ['repo', 'view', '--output', 'json'])) as Fields;
    return text(parsed.default_branch) || null;
  },
  async openRequestUrl(command, branch) {
    const open = parseGlabList(await command('glab', ['mr', 'list', `--source-branch=${branch}`, '--output', 'json']));
    return text(open[0]?.web_url) || null;
  },
  commentCommand: (number, body) => ['glab', ['mr', 'note', String(number), `--message=${body}`]],
  createCommand: (branch, form) => [
    'glab',
    // `--flag=value` throughout, so a value can never be read as another option.
    ['mr', 'create', `--source-branch=${branch}`, `--target-branch=${form.base}`, `--title=${form.title}`, `--description=${form.body}`, '--yes', ...(form.draft ? ['--draft'] : [])],
  ],
  createdUrl: glabCreatedUrl,
  failureReason: (error) => glabFailureReason(error),
};
