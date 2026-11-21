// Start a new session from the latest base (0.0.18, Matt, 2026-11-19). Before Kestrel cuts a new
// session's worktree, it fetches the base branch's upstream (just that branch, with a short time
// limit) and, when the local branch can fast-forward to it, cuts the worktree from the upstream's
// tip instead of the local branch. The user's checkout is never touched: no checkout, no pull, no
// local branch moved; only the remote-tracking ref the fetch itself updates. The base recorded for
// the session is the commit it was cut from, so the upstream's newer commits never count as the
// session's own change. A local branch with commits of its own (ahead or diverged) is used as it is.
// Several sessions started at once share one fetch, and a fetch that ended a moment ago is reused.
import { AUTOMATIC, DEFAULT_REMOTE, missingBaseNotice, type GitDefaults } from './shared/git-defaults.ts';
import { execFile } from 'node:child_process';
import { currentBranch, git, isAncestor, type WorktreeStart } from './git.ts';
import { defaultBranchOf } from './start-base/check.ts';

/** How long a fetch may take before the session starts from the local base anyway. */
export const BASE_FETCH_TIMEOUT_MS = 5_000;
/** How long a finished fetch (or its failure) answers for the same branch again. */
export const BASE_FETCH_REUSE_MS = 30_000;
const MAX_REASON_CHARS = 200;
const FETCH_OUTPUT_BYTES = 1024 * 1024;

/** Runs `git <args>` in `repo`; rejects with the error (carrying `stderr`) when git fails or is past `timeoutMs`. */
export type FetchRunner = (repo: string, args: readonly string[], timeoutMs: number) => Promise<void>;

export interface BaseNotice {
  text: string;
  level: 'info' | 'warning';
}

/** Where a new worktree starts: `start` when the upstream is newer (else the checkout's HEAD, as before), and what to tell the user. */
export interface FreshStart {
  start?: WorktreeStart;
  notice: BaseNotice | null;
}

export interface BaseRefreshOptions {
  /** Settings → Git, "Start new sessions from the latest base branch". Never throws. */
  enabled: () => Promise<boolean>;
  fetch?: FetchRunner;
  now?: () => number;
  timeoutMs?: number;
  reuseMs?: number;
}

interface Upstream {
  branch: string;
  remote: string;
  /** The branch on the remote, `refs/heads/…`. */
  merge: string;
  /** The remote-tracking ref it is fetched into, `refs/remotes/…`. */
  tracking: string;
}

interface HeldFetch {
  /** When it ended; null while it runs. */
  endedAt: number | null;
  /** Null when it worked, else the reason it did not. */
  result: Promise<string | null>;
}

const AS_TODAY: FreshStart = { notice: null };

// No prompt can hang a fetch or pop up: no terminal prompt, no askpass program (an empty
// GIT_ASKPASS turns off core.askPass and SSH_ASKPASS too), no ssh askpass, no credential manager UI.
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };

/** git with an argument list (no shell), killed at the time limit. */
export const runGitFetch: FetchRunner = (repo, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const options = { cwd: repo, env: { ...process.env, ...FETCH_ENV }, timeout: timeoutMs, killSignal: 'SIGKILL' as const, maxBuffer: FETCH_OUTPUT_BYTES };
    execFile('git', [...args], options, (error, _stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve()));
  });

/** The fetch of one branch: forced into its remote-tracking ref, as the default refspec does; no tags, no FETCH_HEAD, no submodules. */
export const fetchArgs = (up: Pick<Upstream, 'remote' | 'merge' | 'tracking'>): string[] => ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', up.remote, `+${up.merge}:${up.tracking}`];

/** A URL's user and password never reach a notice or a log. Pure. */
export const withoutCredentials = (text: string): string => text.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1');

const secondsOf = (ms: number): string => `${Math.round(ms / 100) / 10} seconds`;

/** Why a fetch failed, in one line a person can act on. Pure. */
export function fetchFailure(error: unknown, timeoutMs: number): string {
  const e = error as { killed?: boolean; signal?: string | null; stderr?: string; message?: string };
  if (e.killed || e.signal) return `no answer within ${secondsOf(timeoutMs)}`;
  const lines = (e.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? e.message ?? String(error);
  return withoutCredentials(line.replace(/^(fatal|error):\s*/i, '')).slice(0, MAX_REASON_CHARS);
}

export const fetchFailedNotice = (up: Pick<Upstream, 'remote' | 'branch'>, reason: string): string => `Could not check ${up.remote} for newer ${up.branch}: ${reason}. Started from the local ${up.branch}.`;

export const defaultStartNotice = (branch: string): string => `Started from the latest ${branch}.`;

export const newerNotice = (branch: string, count: number): string => `Started from the latest ${branch} (${count} ${count === 1 ? 'commit' : 'commits'} newer than the local one).`;

/** The checkout's branch and the remote branch it tracks; null when detached, or with no upstream on a remote. */
async function upstreamOf(repo: string): Promise<Upstream | null> {
  const branch = await currentBranch(repo);
  if (!branch) return null;
  const ask = (args: string[]) => git(repo, args, { allowFail: true }).then((out) => out.trim());
  const [remote, merge, tracking] = await Promise.all([
    ask(['config', '--get', `branch.${branch}.remote`]),
    ask(['config', '--get', `branch.${branch}.merge`]),
    ask(['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]),
  ]);
  // '.' is a local branch, not a remote; a name starting with '-' would read as an option.
  if (!remote || remote === '.' || remote.startsWith('-')) return null;
  if (!merge.startsWith('refs/heads/') || !tracking.startsWith('refs/remotes/')) return null;
  return { branch, remote, merge, tracking };
}

const commitOf = (repo: string, ref: string): Promise<string> => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }).then((out) => out.trim());

/** After the fetch: the upstream's tip when the local branch can fast-forward to it, else as today. */
async function newerStart(repo: string, up: Upstream): Promise<FreshStart> {
  const [local, upstream] = await Promise.all([commitOf(repo, `refs/heads/${up.branch}`), commitOf(repo, up.tracking)]);
  if (!local || !upstream || local === upstream) return AS_TODAY;
  // The local branch has commits the upstream lacks (ahead or diverged): never hide them.
  if (!(await isAncestor(repo, local, upstream))) return AS_TODAY;
  const count = Number((await git(repo, ['rev-list', '--count', `${local}..${upstream}`], { allowFail: true })).trim());
  return { start: { head: upstream, base: upstream, baseRef: up.branch }, notice: { text: newerNotice(up.branch, Number.isInteger(count) ? count : 0), level: 'info' } };
}

export class BaseRefresh {
  private readonly held = new Map<string, HeldFetch>();
  private readonly run: FetchRunner;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly reuseMs: number;

  constructor(private readonly opts: BaseRefreshOptions) {
    this.run = opts.fetch ?? runGitFetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? BASE_FETCH_TIMEOUT_MS;
    this.reuseMs = opts.reuseMs ?? BASE_FETCH_REUSE_MS;
  }

  /** Where a new worktree in `repo` starts. Never throws and never refuses: anything wrong starts from the local base. */
  async startFor(repo: string): Promise<FreshStart> {
    try {
      if (!(await this.opts.enabled())) return AS_TODAY;
      const up = await upstreamOf(repo);
      if (!up) return AS_TODAY;
      const failure = await this.fetchOnce(repo, up);
      if (failure) return { notice: { text: fetchFailedNotice(up, failure), level: 'warning' } };
      return await newerStart(repo, up);
    } catch (error) {
      console.error('[kestrel] could not check for a newer base; starting from the local one', error);
      return AS_TODAY;
    }
  }

  /**
   * Where a new worktree starts when it is to start from the default branch (shared/start-base.ts),
   * whatever the checkout is on: the default branch's latest tip. Fetched first when Settings → Git
   * asks for it, as `startFor` does. The local default branch wins only when it has commits of its
   * own (ahead or diverged), so they are never hidden. Never throws: with no default branch it is as today.
   */
  async startFromDefault(repo: string, defaults: GitDefaults = AUTOMATIC): Promise<FreshStart> {
    try {
      const remote = defaults.remote || DEFAULT_REMOTE;
      const hasRemote = (await git(repo, ['config', '--get', `remote.${remote}.url`], { allowFail: true })).trim() !== '';
      const enabled = hasRemote && (await this.opts.enabled());
      // A chosen base branch may not be known here yet (never fetched): ask the remote for it before deciding it is missing.
      const chosen: Upstream | null = defaults.baseBranch ? { branch: defaults.baseBranch, remote, merge: `refs/heads/${defaults.baseBranch}`, tracking: `refs/remotes/${remote}/${defaults.baseBranch}` } : null;
      const early = chosen && enabled ? await this.fetchOnce(repo, chosen) : null;
      const found = await defaultBranchOf(repo, defaults);
      if (!found) return chosen ? { notice: { text: missingBaseNotice(chosen.branch, remote), level: 'warning' } } : AS_TODAY;
      const up: Upstream = chosen ?? { branch: found.name, remote, merge: `refs/heads/${found.name}`, tracking: `refs/remotes/${remote}/${found.name}` };
      const failure = chosen ? early : enabled ? await this.fetchOnce(repo, up) : null;
      const [local, tracked] = await Promise.all([commitOf(repo, `refs/heads/${found.name}`), commitOf(repo, up.tracking)]);
      const tip = local && tracked ? ((await isAncestor(repo, local, tracked)) ? tracked : local) : local || tracked;
      if (!tip) return AS_TODAY;
      const notice: BaseNotice = failure ? { text: fetchFailedNotice(up, failure), level: 'warning' } : { text: defaultStartNotice(found.name), level: 'info' };
      return { start: { head: tip, base: tip, baseRef: found.name }, notice };
    } catch (error) {
      console.error('[kestrel] could not find the default branch; starting from the checkout', error);
      return AS_TODAY;
    }
  }

  /** One fetch per repository and branch at a time, and one that ended within the reuse window answers again. */
  private fetchOnce(repo: string, up: Upstream): Promise<string | null> {
    const key = `${repo}\0${up.tracking}`;
    const held = this.held.get(key);
    if (held && (held.endedAt === null || this.now() - held.endedAt < this.reuseMs)) return held.result;
    const result = this.fetchWithin(repo, up);
    this.held.set(key, { endedAt: null, result });
    void result.then(() => this.held.get(key)?.result === result && this.held.set(key, { endedAt: this.now(), result }));
    return result;
  }

  /** Null when the fetch worked, else why not. Gives up at the time limit even if the runner does not. */
  private async fetchWithin(repo: string, up: Upstream): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`no answer within ${secondsOf(this.timeoutMs)}`), this.timeoutMs);
    });
    const fetched = this.run(repo, fetchArgs(up), this.timeoutMs).then(
      () => null,
      (error: unknown) => fetchFailure(error, this.timeoutMs),
    );
    try {
      return await Promise.race([fetched, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
