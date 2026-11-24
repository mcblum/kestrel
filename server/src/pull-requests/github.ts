// GitHub pull requests through the `gh` CLI ("borrow, do not build"): its sign-in, its API. Run in
// the repository so gh picks the repository from its remotes. The command runner is injected:
// tests never call the real gh. Also GitHub's commands for creating one (`githubCommands`).
//
// What it costs: one `gh pr list` per branch per refresh gives the checks (with the failed ones' names
// and links), the conflict state and the reviews that ask for changes (`latestReviews`). Only when a
// review asks for changes are two more calls made, once per such set of reviews and then remembered
// (`reviewDetailsLookup`): the reviews (for each one's link) and the request's review comments.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipReviewText, REVIEW_COMMENTS_KEPT, type ChangesRequest, type ChecksState, type FailedCheck, type MergeReadiness, type PullRequest, type PullRequestState, type ReviewComment, type ReviewState } from '../shared/details.ts';
import { ready, reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';
import type { CommandRunner, HostCommands, PullRequestProvider } from './types.ts';

export const GH_TIMEOUT_MS = 10_000;
export const GH_FIELDS = 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup,body,author,headRefName,baseRefName,mergeStateStatus,mergeable,headRefOid,latestReviews';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Keeps gh and glab from asking anything or checking for updates while Kestrel waits on them. */
const QUIET_CLI_ENV = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GLAB_NO_PROMPT: 'true', GLAB_CHECK_UPDATE: 'false' };

const exec = promisify(execFile);
export const execRunner: CommandRunner = (command, args, { cwd, timeoutMs }) =>
  exec(command, [...args], { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, ...QUIET_CLI_ENV } });

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/** One check's outcome: a CheckRun has status + conclusion, a StatusContext has state. */
function checkOutcome(item: Record<string, unknown>): 'failed' | 'pending' | 'passed' {
  const conclusion = String(item.conclusion ?? '').toUpperCase();
  const state = String(item.state ?? '').toUpperCase();
  const status = String(item.status ?? '').toUpperCase();
  if (FAILED.has(conclusion) || FAILED.has(state)) return 'failed';
  if (PENDING.has(state) || PENDING.has(status) || (status && status !== 'COMPLETED')) return 'pending';
  return 'passed';
}

/** All checks together: any failure fails, else any still going is running, else passing. */
export function checksOf(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const outcomes = rollup.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null).map(checkOutcome);
  if (outcomes.includes('failed')) return 'failing';
  if (outcomes.includes('pending')) return 'running';
  return outcomes.length > 0 ? 'passing' : 'none';
}

const webUrl = (value: unknown): string | undefined => (typeof value === 'string' && /^https:\/\//.test(value) ? value : undefined);

/**
 * The checks that failed, by name with their log's address: a CheckRun's `name` and `detailsUrl`, a
 * StatusContext's `context` and `targetUrl`. gh's rollup does not say which checks are required, so
 * every failed one is listed. Pure.
 */
export function failedChecksOf(rollup: unknown): FailedCheck[] {
  if (!Array.isArray(rollup)) return [];
  return rollup
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && checkOutcome(i) === 'failed')
    .map((i) => {
      const name = String(i.name ?? i.context ?? '').trim() || 'A check';
      const url = webUrl(i.detailsUrl) ?? webUrl(i.targetUrl);
      return url ? { name, url } : { name };
    });
}

const REVIEW: Record<string, ReviewState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'review-required' };

function stateOf(state: unknown, isDraft: unknown): PullRequestState {
  const s = String(state ?? '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return isDraft === true ? 'draft' : 'open';
}

/** GitHub's mergeStateStatus and mergeable in neutral words; ready needs both CLEAN and MERGEABLE. Pure. */
export function githubReadiness(mergeState: unknown, mergeable: unknown): MergeReadiness {
  if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') return 'conflicts';
  if (mergeState === 'CLEAN' && mergeable === 'MERGEABLE') return 'ready';
  if (mergeState === 'BEHIND') return 'behind';
  if (mergeState === 'BLOCKED') return 'blocked';
  return 'unknown';
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const loginOf = (who: unknown): string | undefined => (who && typeof who === 'object' ? text((who as { login?: unknown }).login) : undefined);

/**
 * The reviews that ask for changes now, from `latestReviews` (each reviewer's newest review): who, and
 * what they wrote. Its id is those reviews' ids, so a new review asking for changes is a new one. Null
 * when none does. The links and comments are added by `reviewDetailsLookup`. Pure.
 */
export function changesRequestedOf(latestReviews: unknown): ChangesRequest | null {
  if (!Array.isArray(latestReviews)) return null;
  const asking = latestReviews.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && r.state === 'CHANGES_REQUESTED');
  if (asking.length === 0) return null;
  const reviewers = asking.map((r) => loginOf(r.author) ?? 'A reviewer');
  const bodies = asking.map((r, i) => ({ who: reviewers[i]!, body: (text(r.body) ?? '').trim() })).filter((b) => b.body);
  const body = bodies.length === 1 && asking.length === 1 ? bodies[0]!.body : bodies.map((b) => `${b.who}: ${b.body}`).join('\n\n');
  return {
    id: asking.map((r) => String(r.id ?? '')).sort().join(','),
    reviewers,
    ...(body ? { body: clipReviewText(body) } : {}),
    comments: [],
  };
}

/** One `gh pr list` item as a pull request. Pure. */
export function mapGhItem(p: Record<string, unknown>): PullRequest {
  const login = p.author && typeof p.author === 'object' ? text((p.author as { login?: unknown }).login) : undefined;
  const readiness = githubReadiness(p.mergeStateStatus, p.mergeable);
  const checks = checksOf(p.statusCheckRollup);
  const state = stateOf(p.state, p.isDraft);
  // Named only while it can still be fixed: a merged or closed request's failures are not asked about.
  const active = state === 'open' || state === 'draft';
  const named = checks === 'failing' && active;
  const review = REVIEW[String(p.reviewDecision ?? '')] ?? 'none';
  const asked = active && review === 'changes-requested' ? changesRequestedOf(p.latestReviews) : null;
  return {
    ...(named ? { failedChecks: failedChecksOf(p.statusCheckRollup) } : {}),
    ...(asked ? { changesRequested: asked } : {}),
    ...(text(p.headRefOid) ? { headSha: text(p.headRefOid) } : {}),
    ...(typeof p.url === 'string' && /^https:\/\//.test(p.url) ? { checksUrl: `${p.url}/checks` } : {}),
    ...(text(p.body) !== undefined ? { body: text(p.body) } : {}),
    ...(login !== undefined ? { author: login } : {}),
    ...(text(p.headRefName) !== undefined ? { headBranch: text(p.headRefName) } : {}),
    ...(text(p.baseRefName) !== undefined ? { baseBranch: text(p.baseRefName) } : {}),
    ...(readiness !== 'unknown' ? { readiness } : {}),
    number: p.number as number,
    title: typeof p.title === 'string' ? p.title : `#${String(p.number)}`,
    state,
    checks,
    review,
    url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url : '',
  };
}

/** `gh pr list --json …` output as pull requests. Throws when it is not a list. Pure. */
export function mapGhPullRequests(json: string): PullRequest[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('gh did not answer with a list');
  return parsed.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof p.number === 'number').map(mapGhItem);
}

export const reviewsArgs = (number: number): string[] => ['api', `repos/{owner}/{repo}/pulls/${number}/reviews?per_page=100`];
export const reviewCommentsArgs = (number: number): string[] => ['api', `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`];

/**
 * `changes` with each asking review's link and the review comments left with them, from the REST
 * reviews (`node_id` matches latestReviews' `id`) and the request's review comments. Pure.
 */
export function withReviewDetails(changes: ChangesRequest, reviewsJson: string, commentsJson: string): ChangesRequest {
  const reviews: unknown = JSON.parse(reviewsJson);
  const comments: unknown = JSON.parse(commentsJson);
  if (!Array.isArray(reviews) || !Array.isArray(comments)) throw new Error('gh did not answer with lists of reviews and comments');
  const ids = new Set(changes.id.split(','));
  const asking = reviews.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && ids.has(String(r.node_id)));
  const reviewIds = new Set(asking.map((r) => r.id));
  const url = webUrl(asking.at(-1)?.html_url);
  const left: ReviewComment[] = comments
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && reviewIds.has(c.pull_request_review_id) && typeof c.body === 'string')
    .slice(0, REVIEW_COMMENTS_KEPT)
    .map((c) => {
      const line = typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : undefined;
      return { body: clipReviewText(String(c.body)), ...(text(c.path) ? { path: text(c.path) } : {}), ...(line !== undefined && Number.isInteger(line) && line >= 0 ? { line } : {}), ...(webUrl(c.html_url) ? { url: webUrl(c.html_url) } : {}) };
    });
  return { ...changes, ...(url ? { url } : {}), comments: left };
}

/** How many sets of reviews' details are remembered. */
const REVIEW_DETAILS_KEPT = 50;

/**
 * The details of the reviews that ask for changes, asked once per set of reviews and remembered; when
 * gh cannot say, the request keeps what the list gave (who, and what they wrote) and is not asked again.
 */
function reviewDetailsLookup(runner: CommandRunner) {
  let kept: ReadonlyMap<string, ChangesRequest> = new Map();
  return async (cwd: string, number: number, changes: ChangesRequest): Promise<ChangesRequest> => {
    const key = `${cwd}\n${number}\n${changes.id}`;
    const known = kept.get(key);
    if (known) return known;
    let found = changes;
    try {
      const ask = async (args: string[]) => (await runner('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout;
      found = withReviewDetails(changes, await ask(reviewsArgs(number)), await ask(reviewCommentsArgs(number)));
    } catch {
      // Kept as the list gave it.
    }
    const next = new Map(kept).set(key, found);
    kept = next.size > REVIEW_DETAILS_KEPT ? new Map([...next].slice(-REVIEW_DETAILS_KEPT)) : next;
    return found;
  };
}

/** Why gh could not answer, said plainly. */
export function ghFailureReason(error: unknown): string {
  const e = error as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (e?.code === 'ENOENT') return 'The gh command is not installed (or not on Kestrel’s PATH)';
  if (e?.killed === true) return `gh did not answer within ${GH_TIMEOUT_MS / 1000} seconds`;
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
  if (/gh auth login|not logged in|authentication/i.test(stderr)) return 'gh is not signed in to GitHub (run gh auth login)';
  return stderr.trim() ? reasonOf(new Error(stderr)) : reasonOf(error);
}

export function githubProvider(runner: CommandRunner = execRunner): PullRequestProvider {
  const reviewDetails = reviewDetailsLookup(runner);
  const detailed = (cwd: string, pr: PullRequest): Promise<PullRequest> | PullRequest =>
    pr.changesRequested ? reviewDetails(cwd, pr.number, pr.changesRequested).then((changesRequested) => ({ ...pr, changesRequested })) : pr;
  return {
    async pullRequestsFor(repoPath, branch): Promise<Sourced<PullRequest[]>> {
      let stdout: string;
      try {
        ({ stdout } = await runner('gh', ['pr', 'list', `--head=${branch}`, '--state', 'all', '--json', GH_FIELDS], { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS }));
      } catch (error) {
        return unavailable(ghFailureReason(error));
      }
      try {
        const mapped = mapGhPullRequests(stdout);
        return ready(await Promise.all(mapped.map((pr) => detailed(repoPath, pr))));
      } catch (error) {
        return unavailable(`gh gave an answer Kestrel cannot read: ${reasonOf(error)}`);
      }
    },
  };
}

/** Creating a pull request on GitHub through gh. */
export const githubCommands: HostCommands = {
  kind: 'github',
  async defaultBranch(command) {
    const parsed = JSON.parse(await command('gh', ['repo', 'view', '--json', 'defaultBranchRef'])) as { defaultBranchRef?: { name?: unknown } };
    return text(parsed.defaultBranchRef?.name) || null;
  },
  async openRequestUrl(command, branch) {
    const existing: unknown = JSON.parse(await command('gh', ['pr', 'list', `--head=${branch}`, '--state=open', '--json', 'url']));
    return (Array.isArray(existing) && text((existing[0] as { url?: unknown } | undefined)?.url)) || null;
  },
  createCommand: (branch, form) => ['gh', ['pr', 'create', `--head=${branch}`, `--base=${form.base}`, `--title=${form.title}`, `--body=${form.body}`, ...(form.draft ? ['--draft'] : [])]],
  commentCommand: (number, body) => ['gh', ['pr', 'comment', String(number), `--body=${body}`]],
  // gh prints the new pull request's address last.
  createdUrl: (stdout) => stdout.trim().split('\n').at(-1)!.trim(),
  failureReason: ghFailureReason,
};
