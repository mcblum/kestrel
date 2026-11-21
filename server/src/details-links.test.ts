// The pull-requests route keeps a session's earlier requests after its branch changes: links are
// recorded from lookups, a new link changes the cache key, a session with no branch answers with its
// links, a later lookup updates the state each was seen in (and with it the session's status), and
// the sample shows several requests and both finished outcomes. Sample mode is used so no git
// worktree is read; the sources are plain functions or the sample provider, never gh or glab.
import { describe, expect, it } from 'vitest';
import { detailsRoute, detailsSources, type DetailsSources } from './details-api.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { PullRequestStore } from './pull-requests/store.ts';
import { SAMPLE_LINKED_SESSION } from './pull-requests/fake.ts';
import { fetchLinked } from './pull-requests/session-requests.ts';
import { seedFakeWorkspace } from './seed.ts';
import type { PullRequest } from './shared/details.ts';
import { statusOf } from './shared/status.ts';
import { ready, unavailable } from './shared/sourced.ts';
import { Workspace } from './workspace.ts';

const pr = (number: number, state: PullRequest['state'] = 'open'): PullRequest => ({ number, title: `#${number}`, state, checks: 'none', review: 'none', url: `https://github.com/o/r/pull/${number}` });

/** A host with these requests per branch, and a workspace with one git project. */
async function world(branches: Record<string, PullRequest[]>) {
  const workspace = new Workspace(memoryPersistence());
  const listed: string[] = [];
  const all = () => Object.values(branches).flat();
  const byNumber = { pullRequestByNumber: async (_r: string, n: number) => ready(all().find((p) => p.number === n) ?? null) };
  const sources: DetailsSources = {
    pullRequests: {
      pullRequestsFor: async (_r, branch) => (listed.push(branch), ready({ host: 'github' as const, pullRequests: branches[branch] ?? [] })),
      linkedRequests: (repo, links) => fetchLinked(byNumber, 'github', repo, links),
    },
    store: new PullRequestStore(() => 0),
  };
  await workspace.addProject({ id: 'p', name: 'P', path: '/nowhere/p', isGit: true });
  const get = async (id: string, url = 'http://x/') => (await detailsRoute(['api', 'sessions', id, 'pull-requests'], 'GET', new URL(url), workspace, undefined, sources, true))!.body;
  return { workspace, get, listed, branches };
}

const numbers = (body: unknown) => (body as { value: { pullRequests: PullRequest[] } }).value.pullRequests.map((p) => p.number);

describe('the pull-requests route with linked requests', () => {
  it('keeps the requests from an earlier branch after the branch changes', async () => {
    const { workspace, get } = await world({ 'feat/a': [pr(10)], 'feat/b': [pr(12)] });
    const session = await workspace.addSession({ title: 'S', agent: 'claude', startedIn: 'p', branch: 'feat/a' });
    expect(numbers(await get(session.id))).toEqual([10]);
    expect(await workspace.requestLinks(session.id)).toMatchObject([{ host: 'github', number: 10, branch: 'feat/a' }]);

    await workspace.setBranch(session.id, 'feat/b');
    expect(numbers(await get(session.id))).toEqual([12, 10]);
    expect((await workspace.requestLinks(session.id)).map((l) => l.number)).toEqual([10, 12]);
  });

  it('asks again at once when a link from another branch appears, and not for one from this branch', async () => {
    const { workspace, get, listed } = await world({ 'feat/b': [pr(12)], 'feat/a': [pr(10)] });
    const session = await workspace.addSession({ title: 'S', agent: 'claude', startedIn: 'p', branch: 'feat/b' });
    await get(session.id);
    await get(session.id);
    expect(listed).toEqual(['feat/b']);
    await workspace.recordRequests(session.id, [{ host: 'github', number: 10, url: pr(10).url, branch: 'feat/a' }]);
    expect(numbers(await get(session.id))).toEqual([12, 10]);
    expect(listed).toEqual(['feat/b', 'feat/b']);
  });

  it('answers with the linked requests for a session with no branch, and unavailable without any', async () => {
    const { workspace, get, listed } = await world({ 'feat/a': [pr(10)] });
    const session = await workspace.addSession({ title: 'S', agent: 'claude', startedIn: 'p', branch: null });
    expect(await get(session.id)).toEqual(unavailable('This session has no branch'));
    await workspace.recordRequests(session.id, [{ host: 'github', number: 10, url: pr(10).url, branch: 'feat/a' }]);
    expect(numbers(await get(session.id))).toEqual([10]);
    expect(listed).toEqual([]);
  });
});

describe('the state a lookup saw', () => {
  const statusIn = async (workspace: Workspace, id: string) => statusOf((await workspace.state()).sessions.find((s) => s.id === id)!);

  it('makes a finished session Ready to review while its request is open, and Done once a later lookup sees it merged', async () => {
    const { workspace, get, branches } = await world({ 'feat/a': [pr(10)] });
    const session = await workspace.addSession({ title: 'S', agent: 'claude', startedIn: 'p', branch: 'feat/a', state: 'done', landedIn: 'p' });
    expect(await statusIn(workspace, session.id)).toBe('done');
    let told = 0;
    workspace.onChange(() => told++);
    await get(session.id);
    expect(told).toBe(1);
    expect(await statusIn(workspace, session.id)).toBe('review');

    await get(session.id, 'http://x/?refresh=1'); // nothing changed: nobody is told
    expect(told).toBe(1);

    branches['feat/a'] = [pr(10, 'merged')];
    await get(session.id, 'http://x/?refresh=1');
    expect(told).toBe(2);
    expect(await workspace.requestLinks(session.id)).toMatchObject([{ number: 10, state: 'merged' }]);
    expect(await statusIn(workspace, session.id)).toBe('done');
  });

  it('reads Done when an older request is open under a newer merged one', async () => {
    const { workspace, get } = await world({ 'feat/a': [pr(10)], 'feat/b': [pr(12, 'merged')] });
    const session = await workspace.addSession({ title: 'S', agent: 'claude', startedIn: 'p', branch: 'feat/a', state: 'done', landedIn: 'p' });
    await get(session.id);
    await workspace.setBranch(session.id, 'feat/b');
    await get(session.id);
    expect(await statusIn(workspace, session.id)).toBe('done');
  });
});

describe('the sample data', () => {
  it('shows a finished session with an open request as Ready to review, and finished ones without as Done', async () => {
    const workspace = new Workspace(memoryPersistence());
    await seedFakeWorkspace(workspace);
    const { sessions } = await workspace.state();
    const named = (title: string) => sessions.find((s) => s.title === title)!;
    expect(statusOf(named('Fix partial writes in the search index'))).toBe('review');
    expect(statusOf(named('Keyboard shortcuts'))).toBe('done');
    expect(named('Draft release notes').landedIn).not.toBeNull();
    expect(statusOf(named('Draft release notes'))).toBe('done');
    expect(sessions.filter((s) => statusOf(s) === 'review').map((s) => s.title)).toEqual(['Fix partial writes in the search index']);
  });

  it('gives "Billing migration" its current request and two from earlier branches', async () => {
    const workspace = new Workspace(memoryPersistence());
    await seedFakeWorkspace(workspace);
    const answer = await detailsRoute(['api', 'sessions', SAMPLE_LINKED_SESSION, 'pull-requests'], 'GET', new URL('http://x/'), workspace, undefined, detailsSources(true), true);
    const found = (answer!.body as { value: { pullRequests: PullRequest[] } }).value.pullRequests;
    expect(found.map((p) => [p.number, p.state, p.checks, p.readiness])).toEqual([
      [421, 'open', 'passing', 'ready'],
      [406, 'open', 'failing', 'blocked'],
      [388, 'merged', 'passing', undefined],
    ]);
  });
});
