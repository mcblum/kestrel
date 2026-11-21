// GitHub pull requests through the `gh` CLI ("borrow, do not build"): its sign-in, its API. Run in
// the repository so gh picks the repository from its remotes. The command runner is injected:
// tests never call the real gh. Also GitHub's commands for creating one (`githubCommands`).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChecksState, MergeReadiness, PullRequest, PullRequestState, ReviewState } from '../shared/details.ts';
import { ready, reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';
import type { CommandRunner, HostCommands, PullRequestProvider } from './types.ts';

export const GH_TIMEOUT_MS = 10_000;
export const GH_FIELDS = 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup,body,author,headRefName,baseRefName,mergeStateStatus,mergeable,headRefOid';
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

/** One `gh pr list` item as a pull request. Pure. */
export function mapGhItem(p: Record<string, unknown>): PullRequest {
  const login = p.author && typeof p.author === 'object' ? text((p.author as { login?: unknown }).login) : undefined;
  const readiness = githubReadiness(p.mergeStateStatus, p.mergeable);
  return {
    ...(text(p.headRefOid) ? { headSha: text(p.headRefOid) } : {}),
    ...(typeof p.url === 'string' && /^https:\/\//.test(p.url) ? { checksUrl: `${p.url}/checks` } : {}),
    ...(text(p.body) !== undefined ? { body: text(p.body) } : {}),
    ...(login !== undefined ? { author: login } : {}),
    ...(text(p.headRefName) !== undefined ? { headBranch: text(p.headRefName) } : {}),
    ...(text(p.baseRefName) !== undefined ? { baseBranch: text(p.baseRefName) } : {}),
    ...(readiness !== 'unknown' ? { readiness } : {}),
    number: p.number as number,
    title: typeof p.title === 'string' ? p.title : `#${String(p.number)}`,
    state: stateOf(p.state, p.isDraft),
    checks: checksOf(p.statusCheckRollup),
    review: REVIEW[String(p.reviewDecision ?? '')] ?? 'none',
    url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url : '',
  };
}

/** `gh pr list --json …` output as pull requests. Throws when it is not a list. Pure. */
export function mapGhPullRequests(json: string): PullRequest[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('gh did not answer with a list');
  return parsed.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof p.number === 'number').map(mapGhItem);
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
  return {
    async pullRequestsFor(repoPath, branch): Promise<Sourced<PullRequest[]>> {
      let stdout: string;
      try {
        ({ stdout } = await runner('gh', ['pr', 'list', `--head=${branch}`, '--state', 'all', '--json', GH_FIELDS], { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS }));
      } catch (error) {
        return unavailable(ghFailureReason(error));
      }
      try {
        return ready(mapGhPullRequests(stdout));
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
