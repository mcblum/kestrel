// The Details pane's sources through their routes: git status against the worktree's base, usage
// summed over turns and kept across a restart, and every way of not knowing said as a reason.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { detailsRoute, detailsSources, NOT_RECORDED, type DetailsSources } from './details-api.ts';
import { baseOf, changedFiles, parseLeftRight } from './git.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import type { Persistence } from './persistence/types.ts';
import { PullRequestStore } from './pull-requests/store.ts';
import { SessionRuntime } from './runtime.ts';
import { ready, unavailable } from './shared/sourced.ts';
import { FakeAgents } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

function world(db: Persistence = memoryPersistence(), costs: (number | undefined)[] = []) {
  const workspace = new Workspace(db);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-details-')));
  const agents = new FakeAgents();
  let turn = 0;
  agents.script = (t) => t.emit({ type: 'done', reason: 'complete', costUsd: costs[turn++] });
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const asked: string[] = [];
  const pullRequests: DetailsSources['pullRequests'] = {
    pullRequestsFor: async (_r, b) => (asked.push(b), ready({ host: 'github' as const, pullRequests: [] })),
    linkedRequests: async () => ready({ host: 'github' as const, pullRequests: [] }),
  };
  const sources: DetailsSources = { pullRequests, store: new PullRequestStore(() => 0) };
  const get = async (id: string, section: string, query = '') => {
    const answer = await detailsRoute(['api', 'sessions', id, section], 'GET', new URL(`http://x/api/sessions/${id}/${section}${query}`), workspace, runtime, sources, false);
    return answer!;
  };
  return { db, workspace, runtime, get, asked };
}

describe('parseLeftRight', () => {
  it('reads git rev-list --left-right --count and refuses anything else', () => {
    expect(parseLeftRight('1\t3\n')).toEqual({ left: 1, right: 3 });
    expect(parseLeftRight('')).toBeNull();
    expect(parseLeftRight('fatal: bad')).toBeNull();
  });
});

describe('the git source', () => {
  it('counts commits on the session branch against the commit its worktree was cut from', async () => {
    const { runtime, get } = world();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Work' });
    await runtime.idle(session.id);
    expect((await get(session.id, 'git')).body).toEqual(ready({ ahead: 0, behind: 0, uncommitted: 0, head: expect.stringMatching(/^[0-9a-f]{40}$/), baseLabel: expect.stringMatching(/^main at [0-9a-f]{7}$/) }));

    const wt = (await runtime.directoryOf(session.id))!;
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    expect((await get(session.id, 'git')).body).toMatchObject({ state: 'ready', value: { ahead: 0, uncommitted: 1 } });
    execFileSync('git', ['add', '.'], { cwd: wt });
    execFileSync('git', ['commit', '-q', '-m', 'b'], { cwd: wt });
    expect((await get(session.id, 'git')).body).toMatchObject({ state: 'ready', value: { ahead: 1, behind: 0, uncommitted: 0 } });
    // Uncommitted work is counted on a branch that already has commits too.
    writeFileSync(join(wt, 'c.txt'), 'c\n');
    expect((await get(session.id, 'git')).body).toMatchObject({ state: 'ready', value: { ahead: 1, uncommitted: 1 } });

    rmSync(wt, { recursive: true, force: true });
    expect((await get(session.id, 'git')).body).toEqual(unavailable('The worktree folder is gone'));
  });

  it('counts the changed files a sidebar row shows, as many as the session\'s Changes, and the uncommitted ones', async () => {
    const { runtime, workspace, get } = world();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Work' });
    await runtime.idle(session.id);
    expect((await get(session.id, 'change-counts')).body).toEqual(ready({ changed: 0, uncommitted: 0, added: 0, removed: 0 }));

    const wt = (await runtime.directoryOf(session.id))!;
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    expect((await get(session.id, 'change-counts')).body).toEqual(ready({ changed: 1, uncommitted: 1, added: 0, removed: 0 }));
    execFileSync('git', ['add', '.'], { cwd: wt });
    execFileSync('git', ['commit', '-q', '-m', 'b'], { cwd: wt });
    // Committed work still differs from the base; nothing is uncommitted.
    expect((await get(session.id, 'change-counts')).body).toEqual(ready({ changed: 1, uncommitted: 0, added: 0, removed: 0 }));
    writeFileSync(join(wt, 'b.txt'), 'b2\n');
    writeFileSync(join(wt, 'c.txt'), 'c\n');
    expect((await get(session.id, 'change-counts')).body).toEqual(ready({ changed: 2, uncommitted: 2, added: 0, removed: 0 }));
    const branch = (await workspace.state()).sessions.find((s) => s.id === session.id)!.branch!;
    expect(await changedFiles(wt, (await baseOf(wt, branch))!)).toHaveLength(2);
    // The lines added and removed are those of the session's changed files as last stored: what its top bar shows.
    await workspace.setDetail(session.id, { files: [{ path: 'b.txt', status: 'M', diff: '--- a/b.txt\n+++ b/b.txt\n@@ -1 +1,2 @@\n-b\n+b2\n+more' }] });
    expect((await get(session.id, 'change-counts')).body).toEqual(ready({ changed: 2, uncommitted: 2, added: 2, removed: 1 }));

    rmSync(wt, { recursive: true, force: true });
    expect((await get(session.id, 'change-counts')).body).toEqual(unavailable('The worktree folder is gone'));
  });

  it('says why when there is no repository or it is a plain folder', async () => {
    const { runtime, get } = world();
    const none = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Look' });
    await runtime.idle(none.id);
    expect((await get(none.id, 'git')).body).toEqual(unavailable('No repository'));
    expect((await get(none.id, 'change-counts')).body).toEqual(unavailable('No repository'));
    const plain = await runtime.registerProject(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-plain-'))));
    const inPlain = await runtime.start({ agent: 'claude', projectId: plain.id, prompt: 'Look' });
    await runtime.idle(inPlain.id);
    expect((await get(inPlain.id, 'git')).body).toEqual(unavailable('Plain folder, no change history'));
    expect((await get(inPlain.id, 'pull-requests')).body).toEqual(unavailable('Plain folder, no change history'));
  });
});

describe('the pull request route', () => {
  it('asks the provider for the session branch, from the cache until refreshed', async () => {
    const { runtime, get, asked } = world();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Work' });
    await runtime.idle(session.id);
    expect((await get(session.id, 'pull-requests')).body).toEqual(ready({ host: 'github', pullRequests: [] }));
    await get(session.id, 'pull-requests');
    await get(session.id, 'pull-requests', '?refresh=1');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/^kestrel\//);
  });

  it('validates its input and says when there is no such session', async () => {
    const { get } = world();
    expect((await get('nope', 'git')).status).toBe(404);
    expect((await get('x'.repeat(101), 'git')).status).toBe(400);
    expect((await get('nope', 'pull-requests', '?refresh=yes')).status).toBe(400);
  });

  it('is not a details route for other paths and methods', async () => {
    const workspace = new Workspace(memoryPersistence());
    const sources = detailsSources(true);
    expect(await detailsRoute(['api', 'sessions', 's', 'files'], 'GET', new URL('http://x/'), workspace, undefined, sources, true)).toBeNull();
    expect(await detailsRoute(['api', 'sessions', 's', 'git'], 'POST', new URL('http://x/'), workspace, undefined, sources, true)).toBeNull();
  });
});

describe('the usage source', () => {
  it('sums the cost each turn reports and keeps it across a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-usage-')), 'kestrel.sqlite');
    const first = world(sqlitePersistence(path), [0.25, 0.17]);
    const session = await first.runtime.start({ agent: 'claude', projectId: null, prompt: 'One' });
    await first.runtime.idle(session.id);
    await first.runtime.reply(session.id, 'Two');
    await first.runtime.idle(session.id);
    expect((await first.get(session.id, 'usage')).body).toEqual(ready({ costUsd: expect.closeTo(0.42, 10), turns: 2 }));
    await first.runtime.shutdown();
    await first.db.close();

    const again = world(sqlitePersistence(path));
    expect((await again.get(session.id, 'usage')).body).toEqual(ready({ costUsd: expect.closeTo(0.42, 10), turns: 2 }));
  });

  it('is not recorded for a session whose agent never reported a cost, or one stored before usage was', async () => {
    const { runtime, workspace, get } = world(memoryPersistence(), [undefined]);
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'One' });
    await runtime.idle(session.id);
    expect((await get(session.id, 'usage')).body).toEqual(unavailable(NOT_RECORDED));
    const old = await workspace.addSession({ title: 'Old', agent: 'claude', startedIn: null, groupId: null, state: 'done', note: '' });
    await workspace.setDetail(old.id, { messages: [], files: [], agentOutput: '' });
    expect((await get(old.id, 'usage')).body).toEqual(unavailable(NOT_RECORDED));
  });
});
