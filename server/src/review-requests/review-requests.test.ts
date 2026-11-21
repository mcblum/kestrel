// Review requests: what each host's answer becomes, which repository a remote names, the store's
// one copy, and the sync that fills it. Sources are plain functions; nothing calls gh or glab.
import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import { remoteRepository } from '../pull-requests/choose.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { asReviewMark, asReviewRequestsView, NO_REVIEW_REQUESTS, reviewingIds, orderReviewRequests, reviewRequestKey, type FoundReviewRequest, type ReviewRequest } from '../shared/review-requests.ts';
import { parseViewPath, selectsRow, viewPath, type View } from '../shared/routes.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { GITHUB_REVIEW_QUERY, githubReviewArgs, githubReviewRequests, mapGithubSearch } from './github.ts';
import { gitlabReviewArgs, gitlabReviewRequests, mapGitlabList } from './gitlab.ts';
import { ReviewRequestStore } from './store.ts';
import { hostsOf, projectRemote, REVIEW_POLL_MS, syncReviewRequests, withProjects, type ReviewRequestSources } from './sync.ts';

const found = (over: Partial<FoundReviewRequest> = {}): FoundReviewRequest => ({ host: 'github', hostName: 'github.com', repository: 'acme/app', number: 7, title: 'Fix the cache', author: 'sam', url: 'https://github.com/acme/app/pull/7', updatedAt: 1_000, ...over });
const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => {
  const base = { ...found(), projectId: null, ...over };
  return { ...base, key: over.key ?? reviewRequestKey(base) };
};

const githubItem = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Fix the cache',
  html_url: 'https://github.com/acme/app/pull/7',
  repository_url: 'https://api.github.com/repos/acme/app',
  user: { login: 'sam' },
  updated_at: '2026-11-20T10:00:00Z',
  body: 'Why and how.',
  draft: false,
  ...over,
});

const gitlabItem = (over: Record<string, unknown> = {}) => ({
  iid: 12,
  title: 'Add retries',
  web_url: 'https://git.example.io/team/tools/api/-/merge_requests/12',
  references: { full: 'team/tools/api!12' },
  author: { username: 'kim' },
  updated_at: '2026-11-19T08:00:00Z',
  description: '',
  draft: false,
  ...over,
});

describe('GitHub review requests', () => {
  it('asks only for requests made of the user by name, never of a team', () => {
    expect(GITHUB_REVIEW_QUERY).toContain('user-review-requested:@me');
    expect(GITHUB_REVIEW_QUERY).not.toMatch(/(^|\s)review-requested:/);
    expect(githubReviewArgs()).toContain(`q=${GITHUB_REVIEW_QUERY}`);
  });

  it('maps a search result, taking the repository from its API address', () => {
    expect(mapGithubSearch(JSON.stringify({ items: [githubItem()] }))).toEqual([found({ updatedAt: Date.parse('2026-11-20T10:00:00Z'), body: 'Why and how.' })]);
  });

  it('leaves out drafts and items it cannot name', () => {
    const items = [githubItem({ draft: true }), githubItem({ repository_url: 'nonsense' }), githubItem({ number: 'x' }), null];
    expect(mapGithubSearch(JSON.stringify({ items }))).toEqual([]);
  });

  it('says why when gh cannot answer, and when the answer is not a search result', async () => {
    const missing: CommandRunner = async () => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(await githubReviewRequests(missing, '/')()).toEqual(unavailable('The gh command is not installed (or not on Kestrel’s PATH)'));
    const odd: CommandRunner = async () => ({ stdout: '[]' });
    expect((await githubReviewRequests(odd, '/')()).state).toBe('unavailable');
  });
});

describe('GitLab review requests', () => {
  it('maps a merge request, taking the full project path from its reference', () => {
    expect(mapGitlabList(JSON.stringify([gitlabItem()]), 'git.example.io')).toEqual([
      { host: 'gitlab', hostName: 'git.example.io', repository: 'team/tools/api', number: 12, title: 'Add retries', author: 'kim', url: 'https://git.example.io/team/tools/api/-/merge_requests/12', updatedAt: Date.parse('2026-11-19T08:00:00Z') },
    ]);
  });

  it('falls back to the address for the project path, and leaves out drafts', () => {
    expect(mapGitlabList(JSON.stringify([gitlabItem({ references: undefined })]), 'h')[0]?.repository).toBe('team/tools/api');
    expect(mapGitlabList(JSON.stringify([gitlabItem({ draft: true }), gitlabItem({ work_in_progress: true })]), 'h')).toEqual([]);
  });

  it('asks who the user is once per server, then for their reviews by name', async () => {
    const asked: string[][] = [];
    const run: CommandRunner = async (_bin, args) => {
      asked.push([...args]);
      return { stdout: args[1] === 'user' ? JSON.stringify({ username: 'matt b' }) : JSON.stringify([gitlabItem()]) };
    };
    const lookup = gitlabReviewRequests(run, '/');
    expect((await lookup('git.example.io')).state).toBe('ready');
    await lookup('git.example.io');
    expect(asked.filter((a) => a[1] === 'user')).toHaveLength(1);
    expect(asked[1]).toEqual(gitlabReviewArgs('git.example.io', 'matt b'));
    expect(asked[1]![1]).toContain('reviewer_username=matt%20b');
  });

  it('says why when glab cannot answer', async () => {
    const failing: CommandRunner = async () => Promise.reject(Object.assign(new Error('x'), { stderr: '401 Unauthorized' }));
    const answer = await gitlabReviewRequests(failing, '/')('git.example.io');
    expect(answer).toEqual(unavailable('glab is not signed in to git.example.io: run `glab auth login --hostname git.example.io` to connect merge requests'));
  });
});

describe('which repository a remote names', () => {
  it('reads https, ssh and scp-like remotes, without .git', () => {
    expect(remoteRepository('https://github.com/acme/app.git')).toBe('acme/app');
    expect(remoteRepository('git@github.com:acme/app.git')).toBe('acme/app');
    expect(remoteRepository('ssh://git@git.example.io:2222/team/tools/api.git')).toBe('team/tools/api');
    expect(remoteRepository('https://git.example.io/team/tools/api/')).toBe('team/tools/api');
  });

  it('is null for a local path or a remote with no repository path', () => {
    expect(remoteRepository('/Users/me/repos/r.git')).toBeNull();
    expect(remoteRepository('https://github.com/acme')).toBeNull();
  });

  it('files a request under the first project on that repository, whatever the case', () => {
    const remotes = [projectRemote('p1', 'git@ssh.github.com:Acme/App.git')!, projectRemote('p2', 'https://github.com/acme/app')!];
    expect(remotes[0]).toEqual({ projectId: 'p1', hostName: 'github.com', repository: 'Acme/App' });
    expect(hostsOf(remotes)).toEqual(['github.com']);
    const [mine, other] = withProjects([found(), found({ repository: 'else/where', number: 3 })], remotes);
    expect(mine).toMatchObject({ projectId: 'p1', key: 'github.com/acme/app/7' });
    expect(other).toMatchObject({ projectId: null });
    expect(projectRemote('p', null)).toBeNull();
    expect(projectRemote('p', '../folder')).toBeNull();
  });
});

describe('ReviewRequestStore', () => {
  it('lists every host together, most recently changed first', () => {
    const store = new ReviewRequestStore();
    store.set('github.com', ready([request({ number: 1, updatedAt: 10 })]));
    store.set('git.example.io', ready([request({ hostName: 'git.example.io', host: 'gitlab', number: 2, updatedAt: 20 })]));
    expect(store.view().requests.map((r) => r.number)).toEqual([2, 1]);
    expect(store.view().problems).toEqual([]);
  });

  it('tells listeners only when what is held really changed', () => {
    const store = new ReviewRequestStore();
    let heard = 0;
    store.onChange(() => heard++);
    store.set('github.com', ready([request()]));
    const view = store.view();
    store.set('github.com', ready([request()]));
    expect(heard).toBe(1);
    expect(store.view()).toBe(view);
    store.set('github.com', ready([request({ title: 'Renamed' })]));
    expect(heard).toBe(2);
  });

  it('keeps a host’s last list when it cannot be asked, and says why', () => {
    const store = new ReviewRequestStore();
    store.set('github.com', ready([request()]));
    store.set('github.com', unavailable('gh is not signed in to GitHub (run gh auth login)'));
    expect(store.view().requests).toHaveLength(1);
    expect(store.view().problems).toEqual([{ hostName: 'github.com', reason: 'gh is not signed in to GitHub (run gh auth login)' }]);
    store.set('github.com', ready([]));
    expect(store.view()).toEqual(NO_REVIEW_REQUESTS);
  });

  it('drops the hosts no project is on any more', () => {
    const store = new ReviewRequestStore();
    store.set('github.com', ready([request()]));
    store.keep([]);
    expect(store.view().requests).toEqual([]);
  });
});

describe('what the UI accepts', () => {
  it('reads a pushed view and drops what is not a request', () => {
    const view = { requests: [request(), { key: 'x' }], problems: [{ hostName: 'h', reason: 'r' }, 3] };
    expect(asReviewRequestsView(view)).toEqual({ requests: [request()], problems: [{ hostName: 'h', reason: 'r' }], order: [] });
    expect(asReviewRequestsView(undefined)).toBe(NO_REVIEW_REQUESTS);
    expect(asReviewRequestsView({ requests: 'no' })).toBe(NO_REVIEW_REQUESTS);
  });

  it('orders by change, then by key', () => {
    const rows = [request({ number: 2, updatedAt: 5 }), request({ number: 1, updatedAt: 5 }), request({ number: 3, updatedAt: 9 })];
    expect(orderReviewRequests(rows).map((r) => r.number)).toEqual([3, 1, 2]);
  });
});

describe('which sessions are reviews', () => {
  const mark = { key: 'github.com/acme/app/7', host: 'github' as const, number: 7, sha: 'a'.repeat(40), url: 'https://github.com/acme/app/pull/7' };

  it('reads a stored mark and nothing else', () => {
    expect(asReviewMark({ ...mark, extra: 1 })).toEqual(mark);
    expect(asReviewMark({ ...mark, sha: 3 })).toBeNull();
    expect(asReviewMark(null)).toBeNull();
  });

  it('is under CODE REVIEWS only while its request still waits on the user', () => {
    const sessions = [{ id: 's1', review: mark }, { id: 's2' }, { id: 's3', review: { key: 'github.com/acme/app/9' } }];
    expect([...reviewingIds(sessions, [request()])]).toEqual(['s1']);
    expect([...reviewingIds(sessions, [])]).toEqual([]);
  });
});

describe('a request’s page', () => {
  it('has a path that names it, slashes in its key and all', () => {
    const view: View = { kind: 'review-request', id: 'github.com/acme/app/7' };
    expect(viewPath(view)).toBe('#/review-request/github.com%2Facme%2Fapp%2F7');
    expect(parseViewPath(viewPath(view))).toEqual(view);
    expect(selectsRow(view, view)).toBe(true);
    expect(selectsRow(view, { kind: 'review-request', id: 'other' })).toBe(false);
  });
});

describe('the sync', () => {
  const project = (id: string, path: string): Project => ({ id, name: id, folders: [{ id: `${id}-f`, path, isGit: true }] });

  function harness(projects: Project[], origins: Record<string, string | null>) {
    let clock = 0;
    let watched = true;
    const asked: string[] = [];
    const answers: { github: Sourced<FoundReviewRequest[]>; gitlab: Sourced<FoundReviewRequest[]> } = { github: ready([found()]), gitlab: ready([]) };
    const sources: ReviewRequestSources = {
      github: async () => (asked.push('github'), answers.github),
      gitlab: async (host) => (asked.push(`gitlab ${host}`), answers.gitlab),
      glabSignIn: async (host) => (host === 'git.example.io' ? { signedIn: true } : { signedIn: false, reason: 'no' }),
      originOf: async (path) => origins[path] ?? null,
    };
    const store = new ReviewRequestStore();
    const sync = syncReviewRequests({ state: async () => ({ projects }) }, sources, store, () => watched, () => clock);
    return { sync, store, asked, answers, projects, advance: (ms: number) => (clock += ms), unwatch: () => (watched = false) };
  }

  it('asks each host its projects are on, once, and files requests under their project', async () => {
    const h = harness([project('p1', '/a'), project('p2', '/b'), project('p3', '/c'), project('p4', '/d')], {
      '/a': 'git@github.com:acme/app.git',
      '/b': 'https://github.com/acme/other.git',
      '/c': 'https://git.example.io/team/tools/api.git',
      '/d': 'https://unknown.example.com/x/y.git',
    });
    await h.sync.check();
    h.sync.stop();
    expect([...h.asked].sort()).toEqual(['github', 'gitlab git.example.io']);
    expect(h.store.view().requests).toEqual([request({ projectId: 'p1' })]);
    expect(h.store.view().problems).toEqual([]);
  });

  it('asks nothing of a host no project is on', async () => {
    const h = harness([project('p1', '/a')], { '/a': null });
    await h.sync.check();
    h.sync.stop();
    expect(h.asked).toEqual([]);
    expect(h.store.view()).toEqual(NO_REVIEW_REQUESTS);
  });

  it('reports a host that could not be asked', async () => {
    const h = harness([project('p1', '/a')], { '/a': 'git@github.com:acme/app.git' });
    h.answers.github = unavailable('gh is not signed in to GitHub (run gh auth login)');
    await h.sync.check();
    h.sync.stop();
    expect(h.store.view().problems).toEqual([{ hostName: 'github.com', reason: 'gh is not signed in to GitHub (run gh auth login)' }]);
  });

  it('asks again only when the pace has passed or the projects changed, and never with no window', async () => {
    const h = harness([project('p1', '/a')], { '/a': 'git@github.com:acme/app.git', '/b': 'git@github.com:acme/other.git' });
    await h.sync.check();
    await h.sync.tick();
    expect(h.asked).toHaveLength(1);
    h.advance(REVIEW_POLL_MS);
    await h.sync.tick();
    expect(h.asked).toHaveLength(2);
    h.projects.push(project('p2', '/b'));
    await h.sync.tick();
    expect(h.asked).toHaveLength(3);
    h.unwatch();
    h.advance(REVIEW_POLL_MS);
    await h.sync.tick();
    h.sync.stop();
    expect(h.asked).toHaveLength(3);
  });
});
