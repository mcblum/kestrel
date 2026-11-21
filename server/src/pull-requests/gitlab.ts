// GitLab merge requests through the `glab` CLI, mapped onto the same PullRequest shape GitHub's use.
// The list (`glab mr list --source-branch <b> --all --output json`) has no pipeline, so each open or
// draft one is viewed too (`glab mr view <iid> --output json`) for `head_pipeline.status`. Review and
// readiness come from `detailed_merge_status` alone: no extra calls for approvals. Also GitLab's
// commands for creating one (`gitlabCommands`). The runner is injected: tests never call glab.
import type { ChecksState, MergeReadiness, PullRequest, PullRequestState, ReviewState } from '../shared/details.ts';
import { ready, reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';
import { execRunner } from './github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from './glab.ts';
import type { CommandRunner, HostCommands, PullRequestProvider } from './types.ts';

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
  return {
    ...(text(mr.sha) ? { headSha: text(mr.sha) } : {}),
    ...(pipeline && typeof pipeline.web_url === 'string' && /^https:\/\//.test(pipeline.web_url) ? { checksUrl: pipeline.web_url } : {}),
    ...(text(mr.description) !== undefined ? { body: text(mr.description) } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(text(mr.source_branch) !== undefined ? { headBranch: text(mr.source_branch) } : {}),
    ...(text(mr.target_branch) !== undefined ? { baseBranch: text(mr.target_branch) } : {}),
    ...(readiness !== 'unknown' ? { readiness } : {}),
    number: mr.iid as number,
    title: typeof mr.title === 'string' ? mr.title : `!${String(mr.iid)}`,
    state: stateOf(mr.state, mr.draft),
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

/** One list item with its single view, for the pipeline; the view wins where both say something. */
async function withView(run: CommandRunner, cwd: string, item: Fields): Promise<PullRequest> {
  const listed = mapGlabMergeRequest(item);
  if (!isActive(listed)) return listed;
  const { stdout } = await run('glab', viewArgs(listed.number), { cwd, timeoutMs: GLAB_TIMEOUT_MS });
  const view: unknown = JSON.parse(stdout);
  if (!hasIid(view)) throw new Error(`glab gave no merge request for !${listed.number}`);
  return mapGlabMergeRequest({ ...item, ...view });
}

const unreadable = (error: unknown) => `glab gave an answer Kestrel cannot read: ${reasonOf(error)}`;

export function gitlabProvider(run: CommandRunner = execRunner): PullRequestProvider {
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
        return ready(await Promise.all(items.map((item) => withView(run, repoPath, item))));
      } catch (error) {
        return unavailable(error instanceof SyntaxError ? unreadable(error) : glabFailureReason(error));
      }
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
