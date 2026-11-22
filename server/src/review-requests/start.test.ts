// Starting a review (start.ts): the commit is fetched from the host's own ref for the request, on a
// real repository with a bare one as its remote; the worktree made from it is at that commit with
// the request's diff as its changes; and who reviews, which folder, and every refusal.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { changedFiles, createWorktree, git as runGit, headCommit } from '../git.ts';
import type { Project, Session } from '../model.ts';
import type { PullRequest } from '../shared/details.ts';
import { reviewRequestKey, type ReviewRequest } from '../shared/review-requests.ts';
import { ready } from '../shared/sourced.ts';
import { NOBODY, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { makeRepo } from '../test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../shared/review-settings.ts';
import { defaultBranchOf, folderOfRequest, localReviewRef, requestHeadRef, REVIEW_BRANCH_PREFIX, reviewerPreset, reviewPrompt, reviewStart, startReview, type StartReviewDeps } from './start.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A checkout with a bare remote that holds a request's head under the host's ref, as GitHub and GitLab do. */
function withRequest(ref: string) {
  const bare = join(tempDir('remote'), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const fork = git(repo, 'rev-parse', 'HEAD');
  const author = join(tempDir('author'), 'clone');
  execFileSync('git', ['clone', '-q', bare, author], { stdio: 'ignore' });
  git(author, 'checkout', '-q', '-b', 'feature');
  commit(author, 'feature.txt', 'new\n');
  const head = commit(author, 'a.txt', 'one\ntwo\n');
  git(author, 'push', '-q', 'origin', `HEAD:${ref}`);
  // Main moves on after the request was opened: the diff must not count that.
  git(author, 'checkout', '-q', 'main');
  commit(author, 'later.txt', 'later\n');
  git(author, 'push', '-q', 'origin', 'main');
  return { repo, fork, head };
}

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => {
  const base = { host: 'github' as const, hostName: 'github.com', repository: 'acme/app', number: 7, title: 'Fix the cache', author: 'sam', url: 'https://github.com/acme/app/pull/7', updatedAt: 1, projectId: 'p1', ...over };
  return { ...base, key: reviewRequestKey(base) };
};

describe('the commit a review starts at', () => {
  it('names each host’s ref for a request’s head', () => {
    expect(requestHeadRef('github', 7)).toBe('refs/pull/7/head');
    expect(requestHeadRef('gitlab', 7)).toBe('refs/merge-requests/7/head');
  });

  it('fetches the head, and bases it where it left the target branch', async () => {
    const { repo, fork, head } = withRequest('refs/pull/7/head');
    const { sha, start } = await reviewStart(runGit, repo, 'github', 7, 'main');
    expect(sha).toBe(head);
    expect(start).toEqual({ head, base: fork, baseRef: 'main' });
    expect(git(repo, 'rev-parse', localReviewRef(7))).toBe(head);
    // The user's checkout is where it was.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(fork);
  });

  it('makes a worktree at that commit whose changes are the request’s own', async () => {
    const { repo, head } = withRequest('refs/merge-requests/12/head');
    const { start } = await reviewStart(runGit, repo, 'gitlab', 12, null);
    const worktree = await createWorktree(repo, tempDir('worktrees'), 'session-1', 'Review: Fix the cache', 'kestrel', start);
    expect(await headCommit(worktree.path)).toBe(head);
    expect((await changedFiles(worktree.path, worktree.base)).map((f) => f.path).sort()).toEqual(['a.txt', 'feature.txt']);
  });

  it('says why when the request cannot be fetched', async () => {
    const { repo } = withRequest('refs/pull/7/head');
    await expect(reviewStart(runGit, repo, 'github', 99, 'main')).rejects.toThrow(/Could not fetch pull request #99 from origin/);
  });
});

describe('the first message', () => {
  const start = { head: 'a'.repeat(40), base: 'b'.repeat(40), baseRef: 'main' };

  it('says what to review, which commit, what to compare with, and not to write to the host', () => {
    const text = reviewPrompt(request(), start.head, start);
    expect(text).toContain('Review pull request #7 in acme/app: "Fix the cache", opened by sam.');
    expect(text).toContain('https://github.com/acme/app/pull/7');
    expect(text).toContain(`at commit ${'a'.repeat(12)}`);
    expect(text).toContain(`git diff ${'b'.repeat(12)}...HEAD\`, against main`);
    expect(text).toContain('Do not push anything, and do not comment on, approve or ask for changes to the pull request on GitHub yourself');
  });

  it('uses GitLab’s words, and says so when there is nothing to compare with', () => {
    const text = reviewPrompt(request({ host: 'gitlab', number: 12 }), start.head, { head: start.head, base: start.head, baseRef: null });
    expect(text).toContain('merge request !12');
    expect(text).toContain('There is no commit to compare it with here');
  });
});

describe('how to review, in the first message', () => {
  const start = { head: 'c'.repeat(40), base: 'd'.repeat(40), baseRef: 'main' };

  it('by default: by reading, with no build and no tests (CI does that), short, with code quoted inline', () => {
    const prompt = reviewPrompt(request(), 'c'.repeat(40), start);
    expect(prompt).toContain(DEFAULT_REVIEW_INSTRUCTIONS);
    expect(DEFAULT_REVIEW_INSTRUCTIONS).toContain('Do not build the project, install its dependencies or run its tests; CI does that');
    expect(DEFAULT_REVIEW_INSTRUCTIONS).toContain('Be clear and reasonably short');
    expect(DEFAULT_REVIEW_INSTRUCTIONS).toContain('exact enough that an engineer or another model could act on it');
    expect(DEFAULT_REVIEW_INSTRUCTIONS).toContain('The brief of a finding is one or two plain sentences');
    expect(DEFAULT_REVIEW_INSTRUCTIONS).toContain('quote the code you mean inline, in backticks');
    expect(prompt).not.toMatch(/Build it|run its tests when/);
  });

  it('says each problem once, as a finding, and not again in the summary', () => {
    const prompt = reviewPrompt(request(), 'c'.repeat(40), start);
    expect(prompt).toContain('the problems, each said once, as a finding');
    expect(prompt).toContain('a brief (one or two plain sentences anyone can read)');
    expect(prompt).toContain('Do not list the problems in the summary as well');
  });

  it('the user’s own instructions take the place of Kestrel’s, and only of those', () => {
    const prompt = reviewPrompt(request(), 'c'.repeat(40), start, 'Only look for SQL injection.');
    expect(prompt).toContain('Only look for SQL injection.');
    expect(prompt).not.toContain(DEFAULT_REVIEW_INSTRUCTIONS);
    // What is reviewed, how it is handed over and that nothing is posted by the agent stay.
    expect(prompt).toContain('Review pull request #7 in acme/app');
    expect(prompt).toContain('Hand over the review with the post_review tool, once');
    expect(prompt).toContain('Do not push anything');
    // Blank instructions are Kestrel's.
    expect(reviewPrompt(request(), 'c'.repeat(40), start, '  ')).toContain(DEFAULT_REVIEW_INSTRUCTIONS);
  });
});

describe('the branch and base of a review', () => {
  it('reads the default branch a remote names', () => {
    expect(defaultBranchOf('ref: refs/heads/develop\tHEAD\n0123abc\tHEAD\n')).toBe('develop');
    expect(defaultBranchOf('0123abc\tHEAD\n')).toBe('');
    expect(defaultBranchOf('')).toBe('');
  });

  it('finds the base when the host does not say the target and this clone records no default branch', async () => {
    const { repo, fork, head } = withRequest('refs/pull/7/head');
    // As after `git remote add`: no origin/HEAD, and no remote-tracking branch yet.
    execFileSync('git', ['remote', 'set-head', 'origin', '--delete'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo, stdio: 'ignore' });
    const { start: found } = await reviewStart(runGit, repo, 'github', 7, null);
    expect(found).toEqual({ head, base: fork, baseRef: 'main' });
  });

  it('names its branch as Kestrel’s, not under the user’s own prefix', () => {
    expect(REVIEW_BRANCH_PREFIX).toBe('kestrel-review');
  });
});

describe('who reviews, and where', () => {
  const preset = (agent: 'claude' | 'codex', model: string) => ({ id: `${agent}-${model}`, name: model, agent, model, effort: 'high', fast: false });
  const who = (reviewers: ReturnType<typeof preset>[]): WhoDoesWhat => ({ ...NOBODY, presets: reviewers, roles: { ...NOBODY.roles, review: reviewers[0]?.id ?? null }, reviewers: reviewers.map((r) => r.id) });

  it('is the first of the user’s reviewers whose agent is connected', () => {
    const set = who([preset('codex', 'gpt'), preset('claude', 'opus')]);
    expect(reviewerPreset(set, ['claude', 'codex'])).toMatchObject({ agent: 'codex', model: 'gpt', effort: 'high' });
    expect(reviewerPreset(set, ['claude'])).toMatchObject({ agent: 'claude', model: 'opus' });
  });

  it('falls back to the first connected agent on its default model', () => {
    expect(reviewerPreset(NOBODY, ['claude'])).toEqual({ agent: 'claude', model: '', effort: '', fast: false });
    expect(reviewerPreset(NOBODY, [])).toBeNull();
  });

  it('finds the folder whose origin is the request’s repository', async () => {
    const project: Project = { id: 'p1', name: 'App', folders: [{ id: 'f1', path: '/docs', isGit: true }, { id: 'f2', path: '/app', isGit: true }, { id: 'f3', path: '/plain', isGit: false }] };
    const origins: Record<string, string> = { '/docs': 'git@github.com:acme/docs.git', '/app': 'https://github.com/Acme/App.git' };
    expect((await folderOfRequest(project, request(), async (path) => origins[path] ?? null))?.id).toBe('f2');
    expect(await folderOfRequest(project, request({ repository: 'acme/none' }), async (path) => origins[path] ?? null)).toBeNull();
  });
});

describe('starting a review', () => {
  const project: Project = { id: 'p1', name: 'App', folders: [{ id: 'f1', path: '/app', isGit: true }] };
  const found = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: 'Fix the cache', url: '', state: 'open', checks: 'none', review: 'none', baseBranch: 'develop', ...over });

  function harness(over: Partial<StartReviewDeps> = {}, sessions: Session[] = []) {
    const started: Parameters<StartReviewDeps['start']>[0][] = [];
    const gitCalls: string[][] = [];
    const sha = 'c'.repeat(40);
    const deps: StartReviewDeps = {
      projects: async () => [project],
      sessions: async () => sessions,
      originOf: async () => 'git@github.com:acme/app.git',
      git: async (_cwd, args) => {
        gitCalls.push(args);
        if (args[0] === 'rev-parse') return `${sha}\n`;
        if (args[0] === 'merge-base') return `${'d'.repeat(40)}\n`;
        return '';
      },
      byNumber: () => ({ pullRequestByNumber: async () => ready(found()) }),
      who: async () => NOBODY,
      connectedAgents: () => ['claude'],
      start: async (req) => (started.push(req), { id: 'new', review: req.review } as Session),
      ...over,
    };
    return { deps, started, gitCalls, sha };
  }

  it('starts a session in the request’s project, at its commit, with the mark and a given title', async () => {
    const h = harness();
    const session = await startReview(h.deps, request());
    expect(session.id).toBe('new');
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({
      agent: 'claude',
      projectId: 'p1',
      folderId: 'f1',
      title: 'Review: Fix the cache',
      start: { head: h.sha, base: 'd'.repeat(40), baseRef: 'develop', prefix: 'kestrel-review' },
      review: { key: 'github.com/acme/app/7', host: 'github', number: 7, sha: h.sha, url: 'https://github.com/acme/app/pull/7' },
    });
    expect(h.gitCalls[0]).toEqual(['fetch', '--quiet', 'origin', '+refs/pull/7/head:refs/kestrel/review/7']);
  });

  it('starts in Auto unless the user chose another mode for reviews', async () => {
    const auto = harness();
    await startReview(auto.deps, request());
    expect(auto.started[0]!.permission).toBe('auto');
    const manual = harness({ permission: async () => 'ask' });
    await startReview(manual.deps, request());
    expect(manual.started[0]!.permission).toBe('ask');
  });

  describe('with "Reviewing" comments', () => {
    const NOW = 1_800_000_000_000;
    const claim = (by: string, minutesAgo = 20) => ({ by, at: NOW - minutesAgo * 60_000 });
    const reviewing = (standing: { other: ReturnType<typeof claim> | null; mine: ReturnType<typeof claim> | null } | Error) => {
      const announced: string[] = [];
      return {
        announced,
        comments: {
          standing: async () => {
            if (standing instanceof Error) throw standing;
            return standing;
          },
          announce: async (_request: unknown, sha: string) => void announced.push(sha),
        },
      };
    };

    it('a review Kestrel starts on its own holds back when somebody else is already reviewing, and says who', async () => {
      const r = reviewing({ other: claim('robin'), mine: null });
      const h = harness({ reviewing: r.comments, announces: async () => true, now: () => NOW });
      await expect(startReview(h.deps, request(), { automatic: true })).rejects.toThrow('robin said they are reviewing this 20 minutes ago, so Kestrel did not start a second review on its own. Start one yourself if you want it anyway.');
      expect(h.started).toHaveLength(0);
      expect(r.announced).toEqual([]);
    });

    it('a review the user starts goes ahead all the same', async () => {
      const r = reviewing({ other: claim('robin'), mine: null });
      const h = harness({ reviewing: r.comments, announces: async () => false, now: () => NOW });
      await startReview(h.deps, request());
      expect(h.started).toHaveLength(1);
    });

    it('says "Reviewing" once the review has started, when the user chose that, naming the commit', async () => {
      const r = reviewing({ other: null, mine: null });
      const h = harness({ reviewing: r.comments, announces: async () => true, now: () => NOW });
      await startReview(h.deps, request(), { automatic: true });
      expect(h.started).toHaveLength(1);
      expect(r.announced).toEqual([h.sha]);
    });

    it('says nothing when the user did not choose it, or already has a comment that stands', async () => {
      const off = reviewing({ other: null, mine: null });
      await startReview(harness({ reviewing: off.comments, announces: async () => false, now: () => NOW }).deps, request());
      expect(off.announced).toEqual([]);
      const already = reviewing({ other: null, mine: claim('me') });
      await startReview(harness({ reviewing: already.comments, announces: async () => true, now: () => NOW }).deps, request());
      expect(already.announced).toEqual([]);
    });

    it('a host that cannot be asked does not stop a review', async () => {
      const r = reviewing(new Error('gh: not signed in'));
      const h = harness({ reviewing: r.comments, announces: async () => false, now: () => NOW });
      await startReview(h.deps, request(), { automatic: true });
      expect(h.started).toHaveLength(1);
    });

    it('a comment that could not be posted is told in the review session, and the review stands', async () => {
      const notices: [string, string][] = [];
      const comments = { standing: async () => ({ other: null, mine: null }), announce: async () => Promise.reject(new Error('HTTP 403: Resource not accessible')) };
      const h = harness({ reviewing: comments, announces: async () => true, notice: (id, text) => void notices.push([id, text]), now: () => NOW });
      const session = await startReview(h.deps, request());
      expect(session.id).toBe('new');
      expect(notices).toEqual([['new', 'The review started, but Kestrel could not post the "Reviewing" comment on the pull request: HTTP 403: Resource not accessible']]);
    });
  });

  it('gives back the review already started, and starts nothing', async () => {
    const existing = { id: 'old', review: { key: 'github.com/acme/app/7' } } as Session;
    const h = harness({}, [existing]);
    expect(await startReview(h.deps, request())).toBe(existing);
    expect(h.started).toEqual([]);
  });

  it('refuses a request in no project, with no matching folder, with no agent, or already merged', async () => {
    await expect(startReview(harness().deps, request({ projectId: null }))).rejects.toThrow('acme/app is not a project in Kestrel');
    await expect(startReview(harness({ originOf: async () => 'git@github.com:acme/else.git' }).deps, request())).rejects.toThrow('No folder of App has acme/app as its origin remote any more.');
    await expect(startReview(harness({ connectedAgents: () => [] }).deps, request())).rejects.toThrow('No agent is connected');
    const merged = harness({ byNumber: () => ({ pullRequestByNumber: async () => ready(found({ state: 'merged' })) }) });
    await expect(startReview(merged.deps, request())).rejects.toThrow('This pull request is merged now');
    expect(merged.started).toEqual([]);
  });
});
