// The workspace's Pull requests route: one entry per request across sessions, built from each
// session's cached lookup (so a session already looked up costs nothing), at most
// LOOKUP_CONCURRENCY lookups at once, minimal entries and a reason when a host cannot be asked,
// archived sessions kept for a week, and the sample data giving every filter a row. Sample mode is used so
// no git worktree is read; the sources are plain functions or the sample provider, never gh or glab.
import { describe, expect, it } from 'vitest';
import { detailsRoute, detailsSources, type DetailsSources } from './details-api.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { PullRequestStore } from './pull-requests/store.ts';
import { fetchLinked } from './pull-requests/session-requests.ts';
import { LOOKUP_CONCURRENCY, mapLimited, pullRequestListRoute, workspaceRequests } from './pull-request-list-api.ts';
import { seedFakeWorkspace } from './seed.ts';
import type { PullRequest } from './shared/details.ts';
import { countRequests, type PullRequestList } from './shared/pull-request-list.ts';
import { ready, unavailable } from './shared/sourced.ts';
import { Workspace } from './workspace.ts';

const pr = (number: number, state: PullRequest['state'] = 'open'): PullRequest => ({ number, title: `PR ${number}`, state, checks: 'none', review: 'none', url: `https://github.com/o/r/pull/${number}` });
const link = (number: number, branch: string, state?: PullRequest['state']) => ({ host: 'github' as const, number, url: pr(number).url, branch, ...(state ? { state } : {}) });

/** A host with these requests per branch (a branch named in `failing` cannot be asked), and a workspace with two git projects. */
async function world(branches: Record<string, PullRequest[]>, failing: readonly string[] = []) {
  const workspace = new Workspace(memoryPersistence());
  const listed: string[] = [];
  const all = () => Object.values(branches).flat();
  const byNumber = { pullRequestByNumber: async (_r: string, n: number) => ready(all().find((p) => p.number === n) ?? null) };
  const sources: DetailsSources = {
    pullRequests: {
      pullRequestsFor: async (_r, branch) => {
        listed.push(branch);
        return failing.includes(branch) ? unavailable('gh is not signed in') : ready({ host: 'github' as const, pullRequests: branches[branch] ?? [] });
      },
      linkedRequests: (repo, links) => fetchLinked(byNumber, 'github', repo, links),
    },
    store: new PullRequestStore(() => 0),
  };
  await workspace.addProject({ id: 'p', name: 'P', path: '/nowhere/p', isGit: true });
  await workspace.addProject({ id: 'q', name: 'Q', path: '/nowhere/q', isGit: true });
  const list = async (url = 'http://x/api/pull-requests') => (await pullRequestListRoute(['api', 'pull-requests'], 'GET', new URL(url), workspace, sources, true))!;
  const body = async (url?: string) => (await list(url)).body as PullRequestList;
  const details = (id: string) => detailsRoute(['api', 'sessions', id, 'pull-requests'], 'GET', new URL('http://x/'), workspace, undefined, sources, true);
  /** A session on `branch` with these requests linked, as earlier lookups would have left them. */
  const linked = async (title: string, projectId: string, branch: string, links: ReturnType<typeof link>[]) => {
    const session = await workspace.addSession({ title, agent: 'claude', startedIn: projectId, branch, state: 'done', landedIn: projectId });
    await workspace.recordRequests(session.id, links);
    return session;
  };
  return { workspace, list, body, details, listed, linked, sources };
}

describe('the Pull requests route', () => {
  it('lists every linked request once, naming every session linked to it', async () => {
    const { body, linked } = await world({ 'feat/a': [pr(10)], 'feat/b': [pr(11)] });
    const a = await linked('A', 'p', 'feat/a', [link(10, 'feat/a')]);
    const b = await linked('B', 'p', 'feat/b', [link(11, 'feat/b'), link(10, 'feat/a')]);
    const answer = await body();
    expect(answer.unasked).toEqual([]);
    expect(answer.requests.map((r) => [r.projectId, r.pullRequest.number, r.pullRequest.title, r.sessions.map((s) => s.title)])).toEqual([
      ['p', 11, 'PR 11', ['B']],
      ['p', 10, 'PR 10', ['A', 'B']],
    ]);
    expect(answer.requests[1]!.sessions).toEqual([{ id: a.id, title: 'A' }, { id: b.id, title: 'B' }]);
  });

  it('keeps the same number in two projects apart', async () => {
    const { body, linked } = await world({ 'feat/a': [pr(10)] });
    await linked('A', 'p', 'feat/a', [link(10, 'feat/a')]);
    await linked('B', 'q', 'feat/a', [link(10, 'feat/a')]);
    expect((await body()).requests.map((r) => r.projectId).sort()).toEqual(['p', 'q']);
  });

  it('asks only sessions with a linked request, and nothing again for one already looked up', async () => {
    const { body, details, listed, linked, workspace } = await world({ 'feat/a': [pr(10)] });
    const a = await linked('A', 'p', 'feat/a', [link(10, 'feat/a')]);
    await workspace.addSession({ title: 'No requests', agent: 'claude', startedIn: 'p', branch: 'feat/none' });
    await details(a.id); // the sidebar or a table asked first
    expect(listed).toEqual(['feat/a']);
    await body();
    await body();
    expect(listed).toEqual(['feat/a']);
    await body('http://x/api/pull-requests?refresh=1');
    expect(listed).toEqual(['feat/a', 'feat/a']);
  });

  it('shows a session whose host cannot be asked by its stored links, and says which project and why', async () => {
    const { body, linked } = await world({ 'feat/a': [pr(10)], 'feat/b': [pr(20)] }, ['feat/b']);
    await linked('A', 'p', 'feat/a', [link(10, 'feat/a')]);
    await linked('B', 'q', 'feat/b', [link(20, 'feat/b', 'draft')]);
    const answer = await body();
    expect(answer.unasked).toEqual([{ projectId: 'q', reason: 'gh is not signed in' }]);
    expect(answer.requests.find((r) => r.pullRequest.number === 20)).toMatchObject({ projectId: 'q', minimal: true, pullRequest: { number: 20, title: '', state: 'draft', url: pr(20).url } });
    expect(answer.requests.find((r) => r.pullRequest.number === 10)).toMatchObject({ minimal: false, pullRequest: { title: 'PR 10' } });
  });

  it('keeps an archived session’s requests for a week after its last activity, marked as archived, then leaves them out', async () => {
    const { linked, workspace, sources } = await world({ 'feat/a': [pr(10)], 'feat/b': [pr(11, 'merged')] });
    await linked('A', 'p', 'feat/a', [link(10, 'feat/a')]);
    const b = await linked('B', 'p', 'feat/b', [link(11, 'feat/b', 'merged')]);
    await workspace.setArchived('session', b.id, true);
    const at = async (now: number) => (await workspaceRequests(workspace, sources, false, true, now)).requests;
    const day = 24 * 60 * 60 * 1000;
    const soon = await at(Date.now() + 6 * day);
    expect(soon.map((r) => [r.pullRequest.number, r.pullRequest.state, r.sessions])).toEqual([
      [11, 'merged', [{ id: b.id, title: 'B', archived: true }]],
      [10, 'open', [{ id: expect.any(String), title: 'A' }]],
    ]);
    expect((await at(Date.now() + 8 * day)).map((r) => r.pullRequest.number)).toEqual([10]);
  });

  it('a request linked to a session in sight and to an archived one names both, the archived one marked', async () => {
    const { linked, workspace, sources } = await world({ 'feat/a': [pr(10)] });
    await linked('A', 'p', 'feat/a', [link(10, 'feat/a')]);
    const old = await linked('Old', 'p', 'feat/a', [link(10, 'feat/a')]);
    await workspace.setArchived('session', old.id, true);
    const [only] = (await workspaceRequests(workspace, sources, false, true, Date.now())).requests;
    expect(only!.sessions.map((x) => [x.title, x.archived ?? false])).toEqual([['A', false], ['Old', true]]);
  });

  it('refuses a refresh that is not 1, and is not the answer for other paths', async () => {
    const { list, workspace } = await world({});
    expect((await list('http://x/api/pull-requests?refresh=yes')).status).toBe(400);
    const sources = detailsSources(true);
    expect(await pullRequestListRoute(['api', 'pull-requests', 'x'], 'GET', new URL('http://x/'), workspace, sources, true)).toBeNull();
    expect(await pullRequestListRoute(['api', 'pull-requests'], 'POST', new URL('http://x/'), workspace, sources, true)).toBeNull();
  });
});

describe('bounded lookups', () => {
  it(`runs at most ${LOOKUP_CONCURRENCY} at once and answers in order`, async () => {
    const items = Array.from({ length: LOOKUP_CONCURRENCY * 3 }, (_, i) => i);
    let running = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const answers = mapLimited(items, LOOKUP_CONCURRENCY, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => waiting.push(resolve));
      running -= 1;
      return n * 2;
    });
    // Let each batch start, then release it: no timers, only the queue of started lookups.
    while (waiting.length > 0 || running > 0) {
      await Promise.resolve();
      waiting.splice(0).forEach((release) => release());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await answers).toEqual(items.map((n) => n * 2));
    expect(most).toBe(LOOKUP_CONCURRENCY);
  });

  it('answers an empty list with nothing', async () => {
    expect(await mapLimited([], LOOKUP_CONCURRENCY, async () => 1)).toEqual([]);
  });
});

describe('the sample data', () => {
  it('gives every filter a row and shows the shared request once with both sessions, the one that had it first first', async () => {
    let now = 0;
    const workspace = new Workspace(memoryPersistence(), () => (now += 1)); // every write a moment later
    await seedFakeWorkspace(workspace);
    const answer = (await pullRequestListRoute(['api', 'pull-requests'], 'GET', new URL('http://x/'), workspace, detailsSources(true), true))!.body as PullRequestList;
    const counts = countRequests(answer.requests);
    expect(Object.values(counts).every((n) => n > 0)).toBe(true);
    const shared = answer.requests.filter((r) => r.pullRequest.number === 406);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.sessions.map((s) => s.title)).toEqual(['Billing migration', 'Background job retries']);
    expect(answer.unasked).toEqual([]);
  });
});
