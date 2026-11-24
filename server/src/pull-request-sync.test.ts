// The sync fills the PR store for every session in sight, asks the host again only for sessions that
// changed (or whose time has come), and forgets sessions that left. Sample data: never gh or glab.
import { worktreeOwnerId } from './shared/working-tree.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { detailsSources } from './details-api.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { syncPullRequests, type PullRequestSync } from './pull-request-sync.ts';
import { seedFakeWorkspace } from './seed.ts';
import { Workspace } from './workspace.ts';

let sync: PullRequestSync | null = null;
afterEach(() => sync?.stop());

async function world() {
  const workspace = new Workspace(memoryPersistence());
  await seedFakeWorkspace(workspace);
  const sources = detailsSources(true);
  let asked = 0;
  const pullRequestsFor = sources.pullRequests.pullRequestsFor;
  const linkedRequests = sources.pullRequests.linkedRequests;
  sources.pullRequests = { ...sources.pullRequests, pullRequestsFor: (repo, branch) => (asked++, pullRequestsFor(repo, branch)), linkedRequests: (repo, links) => (asked++, linkedRequests(repo, links)) };
  sync = syncPullRequests(workspace, sources, true, () => false);
  await sync.check();
  return { workspace, sources, sync, asked: () => asked };
}

describe('syncPullRequests', () => {
  it('holds every session in sight before any window asks, a guest’s under its host', async () => {
    const { workspace, sources } = await world();
    const ids = [...new Set((await workspace.state()).sessions.map(worktreeOwnerId))].sort();
    expect(Object.keys(sources.store.all()).sort()).toEqual(ids);
  });

  it('does not ask the host again when nothing changed', async () => {
    const { sync, asked } = await world();
    const before = asked();
    await sync.check();
    expect(asked()).toBe(before);
  });

  it('asks the host at once about a session whose turn just ended, and not while it runs', async () => {
    const { workspace, sources, sync, asked } = await world();
    // One the host is asked about: a session with no branch or repository is answered without it.
    const session = (await workspace.state()).sessions.find((s) => s.state !== 'running' && sources.store.peek(s.id)?.state === 'ready')!;
    await workspace.setState(session.id, 'running');
    await sync.check();
    const whileRunning = asked();
    await workspace.setState(session.id, 'done');
    await sync.check();
    const afterTurn = asked();
    expect(afterTurn).toBeGreaterThan(whileRunning);
    await sync.check();
    expect(asked()).toBe(afterTurn);
  });

  it('forgets a session that is gone', async () => {
    const { workspace, sources, sync } = await world();
    const id = (await workspace.state()).sessions[0]!.id;
    await workspace.deleteSession(id);
    await sync.check();
    expect(sources.store.all()[id]).toBeUndefined();
  });
});
