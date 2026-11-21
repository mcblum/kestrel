// Starting a new session from the latest base (base-refresh.ts), on real repositories with a local
// bare repository as the remote: the upstream's tip when the local branch can fast-forward, the
// local branch when it has commits of its own, a failed or hung fetch, the setting off, one fetch for
// sessions started together, and the user's checkout left exactly as it was.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { BaseRefresh, fetchArgs, fetchFailure, runGitFetch, withoutCredentials, type FetchRunner } from './base-refresh.ts';
import { aheadBehind, baseOf, changedFiles, createWorktree, headCommit } from './git.ts';
import { makeRepo } from './test-repo.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
const on = async () => true;

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A checkout whose `main` tracks `origin/main` on a bare repository, and another clone that can push newer commits to it. */
function withRemote() {
  const bare = join(tempDir('remote'), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const other = join(tempDir('other'), 'clone');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore' });
  const pushNewer = (count: number) => {
    for (let i = 0; i < count; i++) commit(other, 'b.txt', `newer ${i}\n`);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { bare, repo, pushNewer };
}

/** Everything about the user's checkout a session must not change. */
function snapshot(repo: string) {
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  return { head: git(repo, 'rev-parse', 'HEAD'), main: git(repo, 'rev-parse', 'refs/heads/main'), branch: git(repo, 'branch', '--show-current'), status: git(repo, 'status', '--porcelain'), index: hash(join(repo, '.git', 'index')), file: hash(join(repo, 'a.txt')) };
}

/** The real git fetch, counted. */
function countedFetch(): { run: FetchRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: FetchRunner = async (repo, args, timeoutMs) => {
    calls.push([...args]);
    return runGitFetch(repo, args, timeoutMs);
  };
  return { run, calls };
}

describe('starting from the latest base', () => {
  it('cuts the worktree from the upstream tip when the local branch can fast-forward, with that commit as its base, and leaves the checkout alone', async () => {
    const { repo, pushNewer } = withRemote();
    writeFileSync(join(repo, 'a.txt'), 'uncommitted edit\n'); // the user's own work in progress
    const tip = pushNewer(2);
    const before = snapshot(repo);

    const fresh = await new BaseRefresh({ enabled: on }).startFor(repo);
    expect(fresh).toEqual({ start: { head: tip, base: tip, baseRef: 'main' }, notice: { text: 'Started from the latest main (2 commits newer than the local one).', level: 'info' } });
    const wt = await createWorktree(repo, join(tempDir('data'), 'worktrees'), 'aaaaaaaa-1', 'Fresh', 'kestrel', fresh.start);

    expect(await headCommit(wt.path)).toBe(tip);
    expect(wt.base).toBe(tip);
    expect(await baseOf(wt.path, wt.branch)).toBe(tip);
    expect(await changedFiles(wt.path, tip)).toEqual([]);
    expect(await aheadBehind(wt.path, tip)).toEqual({ ahead: 0, behind: 0 });
    // The checkout, its branch and its index are byte for byte as they were; only origin/main moved.
    expect(snapshot(repo)).toEqual(before);
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(tip);
  });

  it('keeps the base where it was cut even though the local base branch is still behind', async () => {
    const { repo, pushNewer } = withRemote();
    const tip = pushNewer(3);
    const fresh = await new BaseRefresh({ enabled: on }).startFor(repo);
    const wt = await createWorktree(repo, join(tempDir('data'), 'worktrees'), 'bbbbbbbb-1', 'Work', '', fresh.start);
    const own = commit(wt.path, 'c.txt', 'mine\n');
    expect(await baseOf(wt.path, wt.branch)).toBe(tip);
    expect((await changedFiles(wt.path, tip)).map((f) => f.path)).toEqual(['c.txt']);
    expect(await aheadBehind(wt.path, tip)).toEqual({ ahead: 1, behind: 0 });
    expect(own).not.toBe(tip);
  });

  it('starts from the local branch when it has commits the upstream lacks, ahead or diverged', async () => {
    const { repo, pushNewer } = withRemote();
    const local = commit(repo, 'local.txt', 'mine\n');
    const refresh = new BaseRefresh({ enabled: on });
    expect(await refresh.startFor(repo)).toEqual({ notice: null }); // ahead only
    pushNewer(1);
    const diverged = await new BaseRefresh({ enabled: on }).startFor(repo);
    expect(diverged).toEqual({ notice: null });
    const wt = await createWorktree(repo, join(tempDir('data'), 'worktrees'), 'cccccccc-1', 'Local', '', diverged.start);
    expect(await headCommit(wt.path)).toBe(local);
    expect(await changedFiles(wt.path, wt.base)).toEqual([]);
    expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(local);
  });

  it('runs no fetch for a branch with no upstream, or a repository with no remote', async () => {
    const { run, calls } = countedFetch();
    const repo = makeRepo();
    expect(await new BaseRefresh({ enabled: on, fetch: run }).startFor(repo)).toEqual({ notice: null });
    git(repo, 'checkout', '-q', '--detach');
    expect(await new BaseRefresh({ enabled: on, fetch: run }).startFor(repo)).toEqual({ notice: null });
    expect(calls).toEqual([]);
  });

  it('says plainly when the remote cannot be reached, and starts from the local branch', async () => {
    const { repo, bare } = withRemote();
    rmSync(bare, { recursive: true, force: true });
    const fresh = await new BaseRefresh({ enabled: on }).startFor(repo);
    expect(fresh.start).toBeUndefined();
    expect(fresh.notice).toEqual({ level: 'warning', text: expect.stringMatching(/^Could not check origin for newer main: .+\. Started from the local main\.$/) });
  });

  it('gives up on a remote that does not answer within the time limit', async () => {
    const { repo } = withRemote();
    // A transport that just hangs: git's ext:: helper running sleep (allowed in this test repository only).
    git(repo, 'config', 'protocol.ext.allow', 'always');
    git(repo, 'remote', 'set-url', 'origin', 'ext::sh -c sleep% 3');
    const began = Date.now();
    const fresh = await new BaseRefresh({ enabled: on, timeoutMs: 300 }).startFor(repo);
    expect(Date.now() - began).toBeLessThan(2_500);
    expect(fresh).toEqual({ notice: { level: 'warning', text: 'Could not check origin for newer main: no answer within 0.3 seconds. Started from the local main.' } });
  });

  it('gives up at the time limit even when the runner never ends', async () => {
    const { repo } = withRemote();
    const never: FetchRunner = () => new Promise(() => undefined);
    const fresh = await new BaseRefresh({ enabled: on, fetch: never, timeoutMs: 100 }).startFor(repo);
    expect(fresh.notice?.text).toMatch(/no answer within 0.1 seconds/);
  });

  it('runs no fetch at all while the setting is off', async () => {
    const { repo, pushNewer } = withRemote();
    pushNewer(1);
    const { run, calls } = countedFetch();
    expect(await new BaseRefresh({ enabled: async () => false, fetch: run }).startFor(repo)).toEqual({ notice: null });
    expect(calls).toEqual([]);
  });

  it('shares one fetch among sessions started together, and reuses it for a short while', async () => {
    const { repo, pushNewer } = withRemote();
    const tip = pushNewer(1);
    const { run, calls } = countedFetch();
    let now = 1_000;
    const refresh = new BaseRefresh({ enabled: on, fetch: run, now: () => now, reuseMs: 30_000 });
    const starts = await Promise.all([refresh.startFor(repo), refresh.startFor(repo), refresh.startFor(repo)]);
    expect(starts.map((s) => s.start?.head)).toEqual([tip, tip, tip]);
    expect(calls).toHaveLength(1);
    now += 10_000;
    await refresh.startFor(repo);
    expect(calls).toHaveLength(1);
    now += 30_000;
    await refresh.startFor(repo);
    expect(calls).toHaveLength(2);
  });

  it('fetches only the base branch, with an argument list and no tags', () => {
    expect(fetchArgs({ remote: 'origin', merge: 'refs/heads/main', tracking: 'refs/remotes/origin/main' })).toEqual(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  });

  it('never repeats a password from a URL, and names a kill as the time limit', () => {
    expect(withoutCredentials("fatal: unable to access 'https://me:s3cret@example.com/r.git/'")).toBe("fatal: unable to access 'https://example.com/r.git/'");
    expect(fetchFailure({ stderr: "remote: nope\nfatal: Authentication failed for 'https://me:tok@host/x.git/'\n" }, 5_000)).toBe("Authentication failed for 'https://host/x.git/'");
    expect(fetchFailure({ killed: true, signal: 'SIGKILL' }, 5_000)).toBe('no answer within 5 seconds');
  });
});
