import { beforeEach, describe, expect, test } from 'vitest';
import { MAX_HANDOFFS_IN_A_ROW, Refused, Workspace } from './workspace.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { buildTree, rootOf, subtreeIds } from './tree.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import type { Persistence } from './persistence/types.ts';
import { McpServerStore, MCP_SERVERS_KEY } from './mcp-servers/store.ts';
import { memorySecrets } from './mcp-servers/secrets.ts';
import { sessionServers } from './mcp-servers/session.ts';

// The same behaviour must hold on every provider behind the facade.
describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('workspace on %s', (_name, makeDb) => {
  let db: Persistence;
  let ws: Workspace;
  let tick: number;

  beforeEach(async () => {
    tick = 1000;
    db = makeDb();
    ws = new Workspace(db, () => tick++);
    for (const id of ['bellbird', 'platform', 'docs']) await ws.addProject({ id, name: id, path: `/repos/${id}`, isGit: true });
  });

  const add = (id: string, startedIn: string | null, extra: object = {}) => ws.addSession({ id, title: id.toUpperCase(), agent: 'claude', startedIn, ...extra });
  const filings = async () => Object.fromEntries((await ws.state()).sessions.map((s) => [s.id, s.filing]));

  test('records a successful completion once and keeps it through resuming, stopping and filing', async () => {
    await add('garden', 'bellbird');
    await ws.setState('garden', 'done', 'Stopped', { activity: true });
    expect((await db.getSession('garden'))!.completedAt).toBeUndefined();
    await ws.setState('garden', 'running', 'Working', { activity: true });
    await ws.setState('garden', 'done', 'Finished', { activity: true, completed: true });
    const completedAt = (await db.getSession('garden'))!.completedAt;
    expect(completedAt).toBeTypeOf('number');
    await ws.setState('garden', 'running', 'Working', { activity: true });
    await ws.setState('garden', 'done', 'Finished again', { activity: true, completed: true });
    await db.updateSession('garden', { title: 'Renamed', updatedAt: tick++ });
    expect((await db.getSession('garden'))!.completedAt).toBe(completedAt);
  });

  test("a session from Set up this computer's Ask the agent keeps its mark; no other session has one", async () => {
    await add('setup', null, { purpose: 'setup' });
    await add('plain', null);
    expect((await db.getSession('setup'))!.purpose).toBe('setup');
    expect((await db.getSession('plain'))!.purpose).toBeUndefined();
  });

  test('a sidebar keeps what it is about, is filed hidden outside every tree, and goes with its session', async () => {
    await add('main', 'bellbird');
    const of = { sessionId: 'main', at: 'card', key: 'finding:card:f1', name: 'Finding #1', summary: 'It drops the draft.' };
    const detail = { messages: [], files: [], agentOutput: '', kestrelTools: 'unknown' as const };
    const aside = await ws.addAside('main', { title: 'Sidebar: Finding #1', agent: 'claude', startedIn: 'bellbird', aside: of }, detail);
    expect((await db.getSession(aside.id))!.aside).toEqual(of);
    expect((await db.getSession('main'))!.aside).toBeUndefined();
    const state = await ws.state();
    expect(state.sessions.find((s) => s.id === aside.id)!.filing.status).toBe('hidden');
    expect(state.links).toEqual([]);
    await ws.deleteSession('main');
    expect(await db.getSession(aside.id)).toBeNull();
  });

  test('a review session keeps its mark, and it reaches the state the UI is sent', async () => {
    const review = { key: 'github.com/acme/app/7', host: 'github' as const, number: 7, sha: 'a'.repeat(40), url: 'https://github.com/acme/app/pull/7' };
    await add('reviewing', 'bellbird', { review });
    await add('plain', 'bellbird');
    expect((await db.getSession('reviewing'))!.review).toEqual(review);
    expect((await db.getSession('plain'))!.review).toBeUndefined();
    await ws.setState('reviewing', 'done', 'Finished', { activity: true, completed: true });
    const sent = (await ws.state()).sessions;
    expect(sent.find((s) => s.id === 'reviewing')!.review).toEqual(review);
    expect(sent.find((s) => s.id === 'plain')!.review).toBeUndefined();
  });

  describe('groups', () => {
    test('a manual group spans projects and is not marked automatic', async () => {
      const g = await ws.addGroup('November launch');
      await add('a', 'bellbird', { groupId: g.id });
      await add('b', 'platform', { groupId: g.id });
      expect(await db.listGroups()).toEqual([{ id: g.id, name: 'November launch', auto: false, createdAt: g.createdAt, projectId: null }]);
      expect((await ws.state()).trees[g.id]!.map((n) => n.sessionId)).toEqual(['a', 'b']);
    });

    test('deleting a group keeps its sessions and links, ungrouped', async () => {
      const group = await ws.addGroup('Launch');
      await add('o', null, { groupId: group.id });
      await ws.delegate('o', [{ projectId: 'platform', brief: 'p' }]);
      await ws.deleteGroup(group.id);
      expect(await db.listGroups()).toEqual([]);
      expect((await db.listSessions()).every((s) => s.groupId === null)).toBe(true);
      expect(await db.listLinks()).toHaveLength(1);
    });

    test('a group is renamed with the name trimmed, and an empty name or an unknown group is refused', async () => {
      const group = await ws.addGroup('Launch');
      await ws.renameGroup(group.id, '  Checkout latency  ');
      expect((await db.listGroups())[0]).toMatchObject({ name: 'Checkout latency', auto: false });
      await expect(ws.renameGroup(group.id, '   ')).rejects.toThrow(Refused);
      await expect(ws.renameGroup('missing', 'x')).rejects.toThrow(Refused);
    });
  });

  describe('groups in a project', () => {
    test('a project’s group is stored with its project and holds that project’s sessions', async () => {
      const g = await ws.addGroup('Polish', { projectId: 'bellbird' });
      expect((await db.listGroups())[0]).toMatchObject({ name: 'Polish', projectId: 'bellbird' });
      await add('a', 'bellbird', { groupId: g.id });
      expect((await ws.state()).trees[g.id]!.map((n) => n.sessionId)).toEqual(['a']);
      await expect(ws.addGroup('X', { projectId: 'missing' })).rejects.toThrow(/No such project/);
    });

    test('refuses, saying why, a session from another project, started or moved there', async () => {
      const g = await ws.addGroup('Polish', { projectId: 'bellbird' });
      await expect(add('b', 'platform', { groupId: g.id })).rejects.toThrow(/group in another project/);
      await add('c', 'platform');
      await expect(ws.moveSession('c', g.id)).rejects.toThrow(/“C” belongs to platform, and “Polish” is a group in bellbird/);
      expect((await db.getSession('c'))!.groupId).toBeNull();
    });

    test('a session moves into and out of its project’s group, back to the project’s list', async () => {
      const g = await ws.addGroup('Polish', { projectId: 'bellbird' });
      await add('a', 'bellbird');
      await ws.moveSession('a', g.id);
      expect((await db.getSession('a'))!.groupId).toBe(g.id);
      await ws.moveSession('a', null);
      expect((await db.getSession('a'))!.groupId).toBeNull();
    });

    test('deleting a project’s group puts its sessions back in the project’s list', async () => {
      const g = await ws.addGroup('Polish', { projectId: 'bellbird' });
      await add('a', 'bellbird', { groupId: g.id });
      await ws.deleteGroup(g.id);
      expect((await db.getSession('a'))!.groupId).toBeNull();
    });

    test('a Sessions-list group moves into a project only when everything in it belongs there', async () => {
      const g = await ws.addGroup('Launch');
      await add('a', 'bellbird', { groupId: g.id });
      await add('b', 'platform', { groupId: g.id });
      await expect(ws.moveGroupToProject(g.id, 'bellbird')).rejects.toThrow(/holds “B”, which belongs to another project/);
      await ws.moveSession('b', null);
      await ws.moveGroupToProject(g.id, 'bellbird');
      expect((await db.listGroups())[0]!.projectId).toBe('bellbird');
      await expect(ws.moveGroupToProject(g.id, 'platform')).rejects.toThrow(/stays in its project/);
    });

    test('a hand-off child joins its parent’s group only when the group can hold it, or the group asked for', async () => {
      const own = await ws.addGroup('Polish', { projectId: 'bellbird' });
      await add('p', 'bellbird', { groupId: own.id });
      const away = await ws.handoff('p', { projectId: 'platform', summary: 's', markParentDone: false });
      expect(away.groupId).toBeNull();
      const there = await ws.addGroup('Infra', { projectId: 'platform' });
      const into = await ws.handoff('p', { projectId: 'platform', summary: 's2', groupId: there.id, markParentDone: false });
      expect(into.groupId).toBe(there.id);
      await expect(ws.handoff('p', { projectId: 'docs', summary: 's3', groupId: there.id })).rejects.toThrow(/another project/);
    });

    test('removing a project removes its empty groups, and archiving it hides them', async () => {
      const g = await ws.addGroup('Polish', { projectId: 'docs' });
      await ws.setArchived('project', 'docs', true);
      expect((await ws.state()).groups.map((x) => x.id)).not.toContain(g.id);
      await ws.setArchived('project', 'docs', false);
      expect((await ws.state()).groups.map((x) => x.id)).toContain(g.id);
      await ws.removeProject('docs');
      expect(await db.listGroups()).toEqual([]);
    });
  });

  describe('handoff', () => {
    test('starts a linked child in the target project and keeps the parent as done', async () => {
      await add('p', 'bellbird');
      const child = await ws.handoff('p', { projectId: 'platform', summary: 'Fix stale index writes' });
      expect(child).toMatchObject({ startedIn: 'platform', landedIn: null, agent: 'claude', state: 'running' });
      expect((await db.getSession('p'))!.state).toBe('done');
      expect(await db.listLinks()).toMatchObject([{ parentId: 'p', childId: child.id, kind: 'handoff' }]);
    });

    test('keeps the parent in its project and files the child as pending, then under where work lands', async () => {
      await add('p', 'bellbird');
      const child = await ws.handoff('p', { projectId: 'platform', summary: 'C' });
      expect((await filings()).p).toMatchObject({ projectId: 'bellbird', status: 'started' });
      // A parent with no project is listed in no project, as before.
      await add('router', null);
      await ws.handoff('router', { projectId: 'platform', summary: 'R' });
      expect((await filings()).router).toMatchObject({ projectId: null, status: 'hidden' });
      expect((await filings())[child.id]).toMatchObject({ projectId: 'platform', status: 'pending' });
      await ws.setLandedIn(child.id, 'docs');
      expect((await filings())[child.id]).toMatchObject({ projectId: 'docs', status: 'landed' });
    });

    test('the child joins its parent group and uses the caller agent unless one is given', async () => {
      const g = await ws.addGroup('Launch');
      await add('p', 'bellbird', { groupId: g.id, agent: 'codex' });
      expect(await ws.handoff('p', { projectId: 'platform', summary: 'same agent' })).toMatchObject({ groupId: g.id, agent: 'codex' });
      await add('q', 'bellbird', { agent: 'codex' });
      expect(await ws.handoff('q', { projectId: 'docs', summary: 'other agent', agent: 'opencode' })).toMatchObject({ groupId: null, agent: 'opencode' });
    });

    test('refuses an unknown project with a reason the agent can act on, and writes nothing', async () => {
      await add('p', null);
      await expect(ws.handoff('p', { projectId: 'nope', summary: 'x' })).rejects.toThrow(/list_projects/);
      expect(await db.listSessions()).toHaveLength(1);
      expect((await db.getSession('p'))!.state).toBe('running');
    });
  });

  describe('delegate', () => {
    test('starts one linked child per task and moves nothing: no group is made', async () => {
      await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: null });
      const { children } = await ws.delegate('o', [
        { projectId: 'platform', brief: 'Cache pricing' },
        { projectId: 'bellbird', brief: 'Debounce cart', agent: 'codex' },
      ]);
      expect(await db.listGroups()).toEqual([]);
      expect((await db.getSession('o'))!.groupId).toBeNull();
      expect(children.map((c) => [c.startedIn, c.agent, c.groupId])).toEqual([
        ['platform', 'claude', null],
        ['bellbird', 'codex', null],
      ]);
      expect((await db.listLinks()).map((l) => [l.parentId, l.childId, l.kind])).toEqual(children.map((c) => ['o', c.id, 'delegate']));
    });

    test('a child begins in the orchestrator’s group when that group can hold it', async () => {
      const launch = await ws.addGroup('Launch');
      await add('o', null, { groupId: launch.id });
      const { children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }, { projectId: 'docs', brief: 'b' }]);
      expect(children.map((c) => c.groupId)).toEqual([launch.id, launch.id]);
      const tree = (await ws.state()).trees[launch.id]!;
      expect(tree).toHaveLength(1);
      expect(tree[0]!.children.map((c) => [c.sessionId, c.via])).toEqual(children.map((c) => [c.id, 'delegate']));
      // A project's group takes only its own project's sessions.
      const own = await ws.addGroup('Sprint', { projectId: 'bellbird' });
      await add('p', 'bellbird', { groupId: own.id });
      const split = await ws.delegate('p', [{ projectId: 'bellbird', brief: 'c' }, { projectId: 'docs', brief: 'd' }]);
      expect(split.children.map((c) => c.groupId)).toEqual([own.id, null]);
    });

    describe('workstreams', () => {
      test('a split across projects makes a workstream pointing at the orchestrator and its children', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: 'bellbird' });
        const { workstream, created, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'Cache pricing' }], { name: '  Checkout  latency ', objective: ' Make checkout fast again. ' });
        expect(created).toBe(true);
        expect(workstream).toMatchObject({ name: 'Checkout latency', objective: 'Make checkout fast again.', sessionIds: ['o', children[0]!.id] });
        expect((await ws.state()).workstreams).toEqual([workstream]);
        // Nothing moved: both are still filed in their own projects.
        expect((await db.listSessions()).map((s) => [s.startedIn, s.groupId])).toEqual([['bellbird', null], ['platform', null]]);
      });

      test('archiving takes it out of the sidebar list and touches no session; restoring brings it back as it was', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: 'bellbird' });
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'Cache pricing' }]);
        await ws.setState('o', 'done');
        await ws.setState(children[0]!.id, 'done');
        const before = await db.listSessions();
        await ws.setWorkstreamStatus(workstream!.id, 'complete');
        await ws.archiveWorkstream(workstream!.id);
        const archived = await ws.state();
        expect(archived.workstreams).toEqual([]);
        expect(archived.archivedWorkstreams.map((w) => [w.id, w.status, typeof w.archivedAt])).toEqual([[workstream!.id, 'complete', 'number']]);
        // Its sessions keep their places and their link.
        expect(await db.listSessions()).toEqual(before);
        expect(archived.sessions.map((x) => x.id).sort()).toEqual(['o', children[0]!.id].sort());
        expect(archived.links).toHaveLength(1);
        await ws.restoreWorkstream(workstream!.id);
        const restored = await ws.state();
        expect(restored.archivedWorkstreams).toEqual([]);
        expect(restored.workstreams.map((w) => [w.id, w.status, w.archivedAt])).toEqual([[workstream!.id, 'complete', null]]);
      });

      test('an archived workstream stays listed when its sessions are archived too, and restoring it with them brings all back', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: 'bellbird' });
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'Cache pricing' }]);
        const child = children[0]!.id;
        await ws.setState('o', 'done');
        await ws.setState(child, 'done');
        await ws.archiveWorkstream(workstream!.id);
        await ws.setArchived('session', 'o', true);
        await ws.setArchived('session', child, true);
        const hidden = await ws.state();
        expect(hidden.sessions).toEqual([]);
        expect(hidden.archivedWorkstreams.map((w) => [w.id, w.sessionIds])).toEqual([[workstream!.id, ['o', child]]]);
        // Restored alone it has no session in sight, so it is in neither list; its sessions stay archived.
        await ws.restoreWorkstream(workstream!.id);
        const alone = await ws.state();
        expect([alone.workstreams, alone.archivedWorkstreams, alone.sessions]).toEqual([[], [], []]);
        await ws.archiveWorkstream(workstream!.id);
        await ws.restoreWorkstream(workstream!.id, { withSessions: true });
        const back = await ws.state();
        expect(back.workstreams.map((w) => [w.id, w.sessionIds])).toEqual([[workstream!.id, ['o', child]]]);
        expect(back.sessions.map((x) => x.id).sort()).toEqual(['o', child].sort());
        expect(back.archived.sessions).toEqual([]);
        await expect(ws.restoreWorkstream('nope', { withSessions: true })).rejects.toThrow(/No such workstream/);
      });

      test('a new message from the user in one of its sessions restores it and makes it active; nothing else does', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: 'bellbird' });
        await ws.addSession({ id: 'elsewhere', title: 'Unrelated', agent: 'claude', startedIn: 'docs' });
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'Cache pricing' }]);
        // Nothing to resume while it is active and in the sidebar.
        expect(await ws.resumeWorkstreamOf('o')).toBe(false);
        await ws.setState('o', 'done');
        await ws.setState(children[0]!.id, 'interrupted');
        await ws.setWorkstreamStatus(workstream!.id, 'complete');
        await ws.archiveWorkstream(workstream!.id);
        // A session that is not in it changes nothing.
        expect(await ws.resumeWorkstreamOf('elsewhere')).toBe(false);
        expect((await ws.state()).archivedWorkstreams).toHaveLength(1);
        // A worker session's message brings it back, as the lead's would.
        expect(await ws.resumeWorkstreamOf(children[0]!.id)).toBe(true);
        const state = await ws.state();
        expect(state.archivedWorkstreams).toEqual([]);
        expect(state.workstreams.map((w) => [w.status, w.archivedAt])).toEqual([['active', null]]);
      });

      test('archiving waits until none of its sessions is working or waiting on the user, naming them (Matt, 2026-11-19)', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: 'bellbird' });
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'Cache pricing' }]);
        const child = children[0]!.id;
        await ws.setState('o', 'done');
        await ws.setState(child, 'attention');
        await expect(ws.archiveWorkstream(workstream!.id)).rejects.toThrow('“Cache pricing” is still working or waiting on you');
        expect((await ws.state()).archivedWorkstreams).toEqual([]);
        // Stopped is not open work: an unfinished workstream can still be put away.
        await ws.setState(child, 'interrupted');
        await ws.archiveWorkstream(workstream!.id);
        expect((await ws.state()).archivedWorkstreams.map((w) => w.id)).toEqual([workstream!.id]);
      });

      test('a session archived by itself does not hold its workstream back', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: 'bellbird' });
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'Cache pricing' }]);
        await ws.setState(children[0]!.id, 'done');
        await ws.setArchived('session', children[0]!.id, true);
        await expect(ws.archiveWorkstream(workstream!.id)).rejects.toThrow('“Checkout is slow” is still working');
        await ws.setState('o', 'done');
        await ws.setArchived('session', 'o', true);
        await ws.archiveWorkstream(workstream!.id);
        expect((await ws.state()).archivedWorkstreams.map((w) => w.id)).toEqual([workstream!.id]);
      });

      test('refuses to complete, archive or restore a workstream that does not exist', async () => {
        await expect(ws.archiveWorkstream('nope')).rejects.toThrow(/No such workstream/);
        await expect(ws.restoreWorkstream('nope')).rejects.toThrow(/No such workstream/);
        await expect(ws.setWorkstreamStatus('nope', 'complete')).rejects.toThrow(/No such workstream/);
      });

      test('is named after the orchestrator when the agent gives no name', async () => {
        await ws.addSession({ id: 'o', title: 'Checkout is slow', agent: 'claude', startedIn: null });
        expect((await ws.delegate('o', [{ projectId: 'docs', brief: 'x' }])).workstream).toMatchObject({ name: 'Checkout is slow', objective: '' });
      });

      test('a split inside the orchestrator’s own project makes none', async () => {
        await add('o', 'platform');
        expect(await ws.delegate('o', [{ projectId: 'platform', brief: 'Check the readme' }])).toMatchObject({ workstream: null, created: false });
        expect((await ws.state()).workstreams).toEqual([]);
      });

      test('a new workstream takes in what the orchestrator had already delegated, and theirs', async () => {
        await add('o', 'bellbird');
        const own = await ws.delegate('o', [{ projectId: 'bellbird', brief: 'a' }, { projectId: 'bellbird', brief: 'b' }]);
        const below = await ws.delegate(own.children[0]!.id, [{ projectId: 'bellbird', brief: 'c' }]);
        expect((await ws.state()).workstreams).toEqual([]);

        const across = await ws.delegate('o', [{ projectId: 'platform', brief: 'd' }]);

        expect(across.created).toBe(true);
        expect(across.workstream!.sessionIds).toEqual(['o', own.children[0]!.id, below.children[0]!.id, own.children[1]!.id, across.children[0]!.id]);
      });

      test('an earlier delegate that leads a workstream of its own stays in that one', async () => {
        await add('o', 'bellbird');
        const own = await ws.delegate('o', [{ projectId: 'bellbird', brief: 'a' }]);
        const theirs = await ws.delegate(own.children[0]!.id, [{ projectId: 'docs', brief: 'b' }]);

        const across = await ws.delegate('o', [{ projectId: 'platform', brief: 'c' }]);

        expect(across.workstream!.sessionIds).toEqual(['o', across.children[0]!.id]);
        expect((await ws.state()).workstreams.find((w) => w.id === theirs.workstream!.id)!.sessionIds).toEqual([own.children[0]!.id, theirs.children[0]!.id]);
      });

      test('a workstream made before that rule gets its lead’s earlier delegates once, and a removed one stays removed', async () => {
        await add('o', 'bellbird');
        const across = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }]);
        const own = await ws.delegate('o', [{ projectId: 'bellbird', brief: 'b' }]);
        const id = across.workstream!.id;
        // As it was stored before: the own-project delegate was never taken in.
        await ws.removeFromWorkstream(id, own.children[0]!.id);

        await ws.adoptEarlierDelegates();

        const members = async () => (await ws.state()).workstreams.find((w) => w.id === id)!.sessionIds;
        expect(await members()).toEqual(['o', across.children[0]!.id, own.children[0]!.id]);
        await ws.removeFromWorkstream(id, own.children[0]!.id);
        await ws.adoptEarlierDelegates();
        expect(await members()).toEqual(['o', across.children[0]!.id]);
      });

      test('further delegation joins the workstream the orchestrator is in, own-project work included', async () => {
        await add('o', 'bellbird');
        const first = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }]);
        const second = await ws.delegate('o', [{ projectId: 'bellbird', brief: 'b' }]);
        expect(second).toMatchObject({ created: false, workstream: { id: first.workstream!.id } });
        expect((await ws.state()).workstreams).toEqual([{ ...first.workstream!, sessionIds: ['o', first.children[0]!.id, second.children[0]!.id] }]);
        // A child that delegates is in it too, so its own children join the same one.
        const third = await ws.delegate(first.children[0]!.id, [{ projectId: 'docs', brief: 'c' }]);
        expect(third.workstream!.id).toBe(first.workstream!.id);
        expect((await ws.state()).workstreams).toHaveLength(1);
      });

      test('renaming, describing, removing a reference and deleting touch only the workstream', async () => {
        await add('o', 'bellbird');
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }]);
        const id = workstream!.id;
        await ws.renameWorkstream(id, ' Invoices ');
        await ws.setWorkstreamObjective(id, 'Export invoices.');
        expect((await ws.state()).workstreams[0]).toMatchObject({ name: 'Invoices', objective: 'Export invoices.' });
        await expect(ws.renameWorkstream(id, '  ')).rejects.toThrow(/needs a name/);
        await expect(ws.renameWorkstream('missing', 'x')).rejects.toThrow(Refused);
        expect(await ws.removeFromWorkstream(id, children[0]!.id)).toEqual({ index: 1 });
        expect((await ws.state()).workstreams[0]!.sessionIds).toEqual(['o']);
        await expect(ws.removeFromWorkstream(id, children[0]!.id)).rejects.toThrow(/not in/);
        // The lead stays: the workstream is deleted instead. The sessions and the link stay either way.
        await expect(ws.removeFromWorkstream(id, 'o')).rejects.toThrow(/leads this workstream/);
        expect(await db.listSessions()).toHaveLength(2);
        expect(await db.listLinks()).toHaveLength(1);
      });

      test('Undo puts a removed session back where it was, never ahead of the lead', async () => {
        await add('o', 'bellbird');
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }, { projectId: 'docs', brief: 'b' }, { projectId: 'docs', brief: 'c' }]);
        const id = workstream!.id;
        const [a, b, c] = children.map((s) => s.id);
        const { index } = await ws.removeFromWorkstream(id, b!);
        await ws.addBackToWorkstream(id, b!, index);
        expect((await ws.state()).workstreams[0]!.sessionIds).toEqual(['o', a, b, c]);
        await expect(ws.addBackToWorkstream(id, b!, 2)).rejects.toThrow(/already in/);
        await ws.removeFromWorkstream(id, a!);
        await ws.addBackToWorkstream(id, a!, 0);
        expect((await ws.state()).workstreams[0]!.sessionIds).toEqual(['o', a, b, c]);
        await expect(ws.addBackToWorkstream('missing', a!, 1)).rejects.toThrow(Refused);
      });

      test('deleting a workstream keeps its sessions, and a deleted or archived session leaves it', async () => {
        await add('o', 'bellbird');
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }, { projectId: 'docs', brief: 'b' }]);
        await ws.setState(children[0]!.id, 'done');
        await ws.setState(children[1]!.id, 'done');
        await ws.setArchived('session', children[0]!.id, true);
        expect((await ws.state()).workstreams[0]!.sessionIds).toEqual(['o', children[1]!.id]);
        await ws.deleteSession(children[1]!.id);
        expect((await db.listWorkstreams())[0]!.sessionIds).toEqual(['o', children[0]!.id]);
        await ws.deleteWorkstream(workstream!.id);
        expect((await ws.state()).workstreams).toEqual([]);
        expect(await db.listSessions()).toHaveLength(2);
      });
    });

    describe('waits between sessions of a workstream', () => {
      /** A lead and two delegates in three projects: one workstream of three. */
      const three = async () => {
        await add('o', 'bellbird');
        const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }, { projectId: 'docs', brief: 'b' }]);
        const [a, b] = children.map((c) => c.id) as [string, string];
        const wait = { workstreamId: workstream!.id, waiterId: a, targetId: b, reason: 'the export endpoint' };
        return { workstream: workstream!, a, b, wait };
      };

      test('a declared wait is in the state, and declaring it again replaces the reason', async () => {
        const { a, b, wait } = await three();
        await ws.putWait(wait);
        expect((await ws.state()).waits).toEqual([{ ...wait, createdAt: expect.any(Number) }]);
        await ws.putWait({ ...wait, reason: 'the schema too' });
        expect((await ws.state()).waits).toEqual([{ ...wait, reason: 'the schema too', createdAt: expect.any(Number) }]);
        expect(await ws.dropWait(a, b)).toBe(true);
        expect(await ws.dropWait(a, b)).toBe(false);
        expect((await ws.state()).waits).toEqual([]);
      });

      test('is still there for a new workspace on the same store', async () => {
        const { wait } = await three();
        await ws.putWait(wait);
        expect((await new Workspace(db).state()).waits).toEqual([{ ...wait, createdAt: expect.any(Number) }]);
      });

      test('leaving the workstream drops the waits of that session, either side, in the same change', async () => {
        const { workstream, a, b, wait } = await three();
        await ws.putWait(wait);
        await ws.putWait({ ...wait, waiterId: 'o', targetId: a });
        await ws.removeFromWorkstream(workstream.id, b);
        expect((await ws.state()).waits).toMatchObject([{ waiterId: 'o', targetId: a }]);
        await ws.removeFromWorkstream(workstream.id, a);
        expect(await db.listWaits()).toEqual([]);
      });

      test('deleting either session, or the workstream, drops its waits', async () => {
        const { workstream, a, b, wait } = await three();
        await ws.putWait(wait);
        await ws.putWait({ ...wait, waiterId: b, targetId: 'o' });
        await ws.deleteSession(a);
        expect((await db.listWaits()).map((w) => [w.waiterId, w.targetId])).toEqual([[b, 'o']]);
        await ws.deleteWorkstream(workstream.id);
        expect(await db.listWaits()).toEqual([]);
      });

      test('archiving the workstream keeps its waits; an archived session’s waits are kept but not shown', async () => {
        const { workstream, a, b, wait } = await three();
        await ws.putWait(wait);
        const stored = { ...wait, createdAt: expect.any(Number) };
        await Promise.all(['o', a, b].map((id) => ws.setState(id, 'done')));
        await ws.archiveWorkstream(workstream.id);
        expect((await ws.state()).waits).toEqual([stored]);
        await ws.setState(a, 'done');
        await ws.setArchived('session', a, true);
        expect((await ws.state()).waits).toEqual([]);
        expect(await db.listWaits()).toEqual([stored]);
        await ws.setArchived('session', a, false);
        expect((await ws.state()).waits).toEqual([stored]);
      });
    });

    test('the orchestrator is filed by the ordinary rule', async () => {
      await add('o', null);
      await ws.delegate('o', [{ projectId: 'platform', brief: 'p' }]);
      expect((await filings()).o!.status).toBe('unscoped');
    });

    test('refuses more children than the limit and leaves no group behind', async () => {
      await add('o', null);
      const tasks = Array.from({ length: DEFAULT_LIMITS.maxChildrenPerDelegate + 1 }, (_, i) => ({ projectId: 'docs', brief: `t${i}` }));
      await expect(ws.delegate('o', tasks)).rejects.toThrow(Refused);
      expect(await db.listGroups()).toEqual([]);
    });

    test('refuses a tree deeper than the limit', async () => {
      await add('o', null);
      const level1 = (await ws.delegate('o', [{ projectId: 'platform', brief: 'l1' }])).children[0]!;
      const level2 = (await ws.delegate(level1.id, [{ projectId: 'docs', brief: 'l2' }])).children[0]!;
      await expect(ws.delegate(level2.id, [{ projectId: 'bellbird', brief: 'l3' }])).rejects.toThrow(/levels deep/);
    });

    test('a handoff is not a level of the tree: the task moved, and the new session is nobody’s child (Matt, 2026-11-20)', async () => {
      await add('o', null);
      const level1 = (await ws.delegate('o', [{ projectId: 'platform', brief: 'l1' }])).children[0]!;
      const level2 = (await ws.delegate(level1.id, [{ projectId: 'docs', brief: 'l2' }])).children[0]!;
      // At the deepest level a delegation is refused, a handoff is not.
      const moved = await ws.handoff(level2.id, { projectId: 'bellbird', summary: 'moved' });
      const { links } = await ws.state();
      expect(subtreeIds('o', links)).not.toContain(moved.id);
      expect(rootOf(moved.id, links)).toBe(moved.id);
      // So it starts a tree of its own, with its own levels.
      await expect(ws.delegate(moved.id, [{ projectId: 'docs', brief: 'fresh' }])).resolves.toBeDefined();
    });

    test('a task cannot be handed off forever', async () => {
      await add('o', null);
      let at = 'o';
      for (let i = 0; i < MAX_HANDOFFS_IN_A_ROW; i++) at = (await ws.handoff(at, { projectId: 'docs', summary: `h${i}` })).id;
      await expect(ws.handoff(at, { projectId: 'docs', summary: 'one more' })).rejects.toThrow(/handed off 5 times in a row/);
    });

    test('checks against the limits in force, which the user sets (Matt, 2026-11-19)', async () => {
      await add('o', null);
      await ws.limits.set({ maxChildrenPerDelegate: 2, maxDepth: 3, maxLiveSessionsPerTree: 4 });
      await expect(ws.delegate('o', [1, 2, 3].map((i) => ({ projectId: 'docs', brief: `t${i}` })))).rejects.toThrow('delegate takes at most 2 tasks; got 3');
      // A third level is now allowed, a fourth is not.
      const level1 = (await ws.delegate('o', [{ projectId: 'platform', brief: 'l1' }])).children[0]!;
      const level2 = (await ws.delegate(level1.id, [{ projectId: 'docs', brief: 'l2' }])).children[0]!;
      const level3 = (await ws.delegate(level2.id, [{ projectId: 'bellbird', brief: 'l3' }])).children[0]!;
      await expect(ws.delegate(level3.id, [{ projectId: 'docs', brief: 'l4' }])).rejects.toThrow('at most 3 levels deep');
      // o, l1, l2 and l3 are live: a fifth is refused, a spawn included.
      await expect(ws.spawn('o', { projectId: 'docs', title: 'x' })).rejects.toThrow('at most 4 live sessions; this one has 4');
      await ws.limits.reset();
      expect(await ws.limits.current()).toEqual(DEFAULT_LIMITS);
    });

    test('refuses more live sessions in one tree than the limit', async () => {
      await add('o', null);
      const many = (n: number) => Array.from({ length: n }, (_, i) => ({ projectId: 'docs', brief: `t${i}` }));
      const first = (await ws.delegate('o', many(5))).children; // 6 live: o + 5
      await ws.delegate(first[0]!.id, many(4)); // 10 live
      await expect(ws.delegate(first[1]!.id, many(1))).rejects.toThrow(/live sessions/);
    });
  });

  describe('moving sessions between groups', () => {
    const setup = async () => {
      const group = await ws.addGroup('Split');
      await add('o', null, { groupId: group.id });
      const { children } = await ws.delegate('o', [
        { projectId: 'platform', brief: 'c1' },
        { projectId: 'bellbird', brief: 'c2' },
      ]);
      const other = await ws.addGroup('Other');
      return { group, other, c1: children[0]!, c2: children[1]! };
    };

    test('dragging an orchestrator moves its whole subtree', async () => {
      const { other, c1, c2 } = await setup();
      const moved = await ws.moveSession('o', other.id);
      expect([...moved].sort()).toEqual(['o', c1.id, c2.id].sort());
      expect((await db.listSessions()).every((s) => s.groupId === other.id)).toBe(true);
    });

    test('dragging a child moves only that child, which then shows at the top level with a from mark', async () => {
      const { group, other, c1, c2 } = await setup();
      expect(await ws.moveSession(c1.id, other.id)).toEqual([c1.id]);
      const trees = (await ws.state()).trees;
      expect(trees[other.id]).toEqual([{ sessionId: c1.id, via: null, movedFrom: 'o', children: [] }]);
      expect(trees[group.id]![0]!.children.map((c) => c.sessionId)).toEqual([c2.id]);
    });

    test('a move never changes links', async () => {
      const { other, c1 } = await setup();
      const before = await db.listLinks();
      await ws.moveSession(c1.id, other.id);
      await ws.moveSession('o', null);
      expect(await db.listLinks()).toEqual(before);
    });

    test('an orchestrator leaves behind children that were already moved elsewhere', async () => {
      const { other, c1, c2 } = await setup();
      await ws.moveSession(c1.id, other.id);
      await ws.moveSession('o', null);
      const where = Object.fromEntries((await db.listSessions()).map((s) => [s.id, s.groupId]));
      expect(where).toEqual({ o: null, [c1.id]: other.id, [c2.id]: null });
    });

    test('refuses a move to a folder that does not exist', async () => {
      await setup();
      await expect(ws.moveSession('o', 'missing')).rejects.toThrow(Refused);
    });
  });

  describe('trail', () => {
    test('lists ancestors, the session, then its children, with how each was reached', async () => {
      await add('p', 'bellbird');
      const mid = await ws.handoff('p', { projectId: 'platform', summary: 'Mid' });
      const leaf = await ws.handoff(mid.id, { projectId: 'docs', summary: 'Leaf' });
      const trail = (await ws.detail(mid.id))!.trail;
      expect(trail.map((t) => [t.sessionId, t.via, t.current])).toEqual([
        ['p', null, false],
        [mid.id, 'handoff', true],
        [leaf.id, 'handoff', false],
      ]);
      // A parent that changed nothing stays listed in the project it was started in.
      expect(trail[0]).toMatchObject({ filingStatus: 'started', projectName: 'bellbird', state: 'done' });
    });
  });

  describe('restart', () => {
    test('running sessions are marked interrupted; others are left alone', async () => {
      await add('r', null, { state: 'running' });
      await add('a', null, { state: 'attention' });
      await add('d', null, { state: 'done' });
      expect(await ws.markRunningInterrupted()).toBe(1);
      expect(Object.fromEntries((await db.listSessions()).map((s) => [s.id, s.state]))).toEqual({ r: 'interrupted', a: 'attention', d: 'done' });
    });

    test('a worktree can be attached after the session exists', async () => {
      await add('s', 'bellbird');
      await ws.attachWorktree('s', { path: '/wt/s', branch: 'kestrel/s' });
      expect(await db.getSession('s')).toMatchObject({ worktreePath: '/wt/s', branch: 'kestrel/s', worktreeDiscarded: false });
    });

    test('a branch renamed inside the worktree is recorded, and is not activity', async () => {
      await add('s', 'bellbird', { worktreePath: '/wt/s', branch: 'kestrel/s' });
      const before = (await db.getSession('s'))!.updatedAt;
      await ws.setBranch('s', 'fix/the-real-name');
      expect(await db.getSession('s')).toMatchObject({ branch: 'fix/the-real-name', worktreePath: '/wt/s', updatedAt: before });
    });

    test('landedIn survives the worktree being discarded', async () => {
      await add('s', 'bellbird', { worktreePath: '/wt/s', landedIn: 'bellbird' });
      await ws.discardWorktree('s');
      expect((await filings()).s).toEqual({ projectId: 'bellbird', status: 'landed', discarded: true });
    });
  });

  describe('latest activity', () => {
    const activity = async (id: string) => (await db.getSession(id))?.lastActivityAt;

    test('starts when the session is created and moves only with activity', async () => {
      await add('s', 'bellbird');
      const created = await activity('s');
      expect(created).toBe((await db.getSession('s'))!.createdAt);
      await ws.setState('s', 'running', 'Reading files');
      await ws.renameSession('s', 'Renamed');
      await ws.tagSession('s', 'launch');
      await ws.setPinned('session', 's', true);
      await ws.moveSession('s', (await ws.addGroup('G')).id);
      await ws.setLandedIn('s', 'bellbird');
      await ws.attachWorktree('s', { path: '/wt/s', branch: 'kestrel/s' });
      await ws.discardWorktree('s');
      expect(await activity('s')).toBe(created);
      await ws.setState('s', 'done', 'Finished', { activity: true });
      const after = await db.getSession('s');
      expect(after!.lastActivityAt).toBe(after!.updatedAt);
      expect(after!.lastActivityAt).toBeGreaterThan(created!);
    });
  });

  describe('state cache', () => {
    test('readers share one derived state until something changes', async () => {
      await add('a', 'bellbird');
      const [first, second] = await Promise.all([ws.state(), ws.state()]);
      expect(second).toBe(first);
      expect(await ws.state()).toBe(first);
      await ws.setState('a', 'done');
      const after = await ws.state();
      expect(after).not.toBe(first);
      expect(after.sessions[0]!.state).toBe('done');
    });

    test('a read that started before a write never becomes the cached state', async () => {
      await add('a', 'bellbird');
      const stale = ws.state();
      await ws.setState('a', 'done');
      await stale;
      expect((await ws.state()).sessions[0]!.state).toBe('done');
    });

    test('listeners hear about committed writes and not about refused ones', async () => {
      let changes = 0;
      ws.onChange(() => changes++);
      await add('a', 'bellbird');
      await expect(ws.handoff('a', { projectId: 'nope', summary: 'x' })).rejects.toThrow(Refused);
      expect(changes).toBe(1);
    });
  });

  describe('persistence facade', () => {
    test('a failed transaction keeps nothing it wrote', async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.insertGroup({ id: 'g', name: 'G', auto: false, createdAt: 1 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await db.listGroups()).toEqual([]);
    });

    test('calls made while a transaction is open wait for it instead of joining it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const order: string[] = [];
      const tx = db.transaction(async (t) => {
        await t.insertGroup({ id: 'g1', name: 'in tx', auto: false, createdAt: 1 });
        await gate;
        order.push('tx done');
        throw new Error('rolled back');
      });
      const outside = db.insertGroup({ id: 'g2', name: 'outside', auto: false, createdAt: 2 }).then(() => order.push('outside done'));
      release();
      await expect(tx).rejects.toThrow('rolled back');
      await outside;
      expect(order).toEqual(['tx done', 'outside done']);
      expect((await db.listGroups()).map((g) => g.id)).toEqual(['g2']);
    });

    test('a session can have only one parent', async () => {
      await add('a', null);
      await add('b', null);
      await add('c', null);
      await db.insertLink({ id: 'l1', parentId: 'a', childId: 'c', kind: 'handoff' });
      await expect(db.insertLink({ id: 'l2', parentId: 'b', childId: 'c', kind: 'handoff' })).rejects.toThrow();
    });
  });

  describe('the replica tables', () => {
    const head = (id: string, runsOn: string, createdAt: number) => ({ id, runsOn, title: id, agent: 'claude' as const, state: 'done' as const, note: '', project: null, repos: [], filing: 'unscoped' as const, branch: null, request: null, createdAt, updatedAt: createdAt, lastActivityAt: createdAt, messages: 0, chunks: 0 });
    const chunk = (n: number) => ({ n, messages: [{ author: 'agent' as const, time: '', text: `chunk ${n}` }] });

    test('heads are listed oldest first and replaced by id', async () => {
      await db.putAccountSessions([head('b', 'mini', 2), head('a', 'mini', 1)]);
      await db.putAccountSessions([{ ...head('a', 'mini', 1), title: 'renamed' }]);
      expect((await db.listAccountSessions()).map((h) => [h.id, h.title])).toEqual([['a', 'renamed'], ['b', 'b']]);
    });

    test('a conversation is read a range of chunks at a time, and goes with its head', async () => {
      await db.putAccountSessions([head('a', 'mini', 1)]);
      await db.putAccountDetails('a', [chunk(2), chunk(0), chunk(1), chunk(3)]);
      await db.putAccountDetails('a', [{ n: 1, messages: [{ author: 'agent', time: '', text: 'again' }] }]);
      expect((await db.listAccountDetails('a', 1, 3)).map((c) => [c.n, c.messages[0]!.text])).toEqual([[1, 'again'], [2, 'chunk 2']]);
      await db.deleteAccountDetails('a', 2);
      expect((await db.listAccountDetails('a', 0, 10)).map((c) => c.n)).toEqual([0, 1]);
      await db.deleteAccountSessions(['a']);
      expect(await db.listAccountDetails('a', 0, 10)).toEqual([]);
    });

    test('records are kept by key, and a failed transaction keeps none of it', async () => {
      await db.putAccountRecord('machine|mini', 'one');
      await db.putAccountRecord('machine|mini', 'two');
      await expect(
        db.transaction(async (tx) => {
          await tx.putAccountSessions([head('a', 'mini', 1)]);
          await tx.deleteAccountRecord('machine|mini');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await db.listAccountSessions()).toEqual([]);
      expect(await db.listAccountRecords()).toEqual([{ key: 'machine|mini', value: 'two' }]);
    });

    test('they are no part of this computer’s own sessions', async () => {
      await db.putAccountSessions([{ ...head('a', 'mini', 1), state: 'running' }]);
      expect(await db.listSessions()).toEqual([]);
      expect(await db.markRunningInterrupted()).toBe(0);
      expect((await ws.state()).sessions).toEqual([]);
    });
  });

  describe('writes of several steps', () => {
    /** The same store with some calls replaced, inside transactions as well as outside. */
    const replacing = (base: Persistence, calls: Partial<Persistence>): Persistence =>
      new Proxy(base, {
        get(target, name, receiver) {
          if (name === 'transaction') return <T>(fn: (tx: Persistence) => Promise<T>) => target.transaction((tx) => fn(replacing(tx, calls)));
          const own = calls[name as keyof Persistence];
          return own ?? Reflect.get(target, name, receiver);
        },
      });
    const boom = async (): Promise<never> => {
      throw new Error('boom');
    };

    test('deleting a session keeps it whole when a later step fails', async () => {
      await add('s', 'bellbird');
      await ws.setPinned('session', 's', true);
      await expect(new Workspace(replacing(db, { deletePin: boom })).deleteSession('s')).rejects.toThrow('boom');
      expect(await db.getSession('s')).not.toBeNull();
      expect(await db.listPins()).toHaveLength(1);
    });

    test('deleting a group keeps it, its sessions in it and its pin when a later step fails', async () => {
      const g = await ws.addGroup('Launch');
      await add('a', 'bellbird', { groupId: g.id });
      await ws.setPinned('group', g.id, true);
      await expect(new Workspace(replacing(db, { deletePin: boom })).deleteGroup(g.id)).rejects.toThrow('boom');
      expect((await db.listGroups()).map((x) => x.id)).toEqual([g.id]);
      expect((await db.getSession('a'))!.groupId).toBe(g.id);
      expect(await db.listPins()).toHaveLength(1);
    });

    test('deleting a group takes it off the archive with its pin, and its sessions show again, ungrouped', async () => {
      const g = await ws.addGroup('Launch');
      await add('a', 'bellbird', { groupId: g.id });
      await ws.setState('a', 'done');
      await ws.setArchived('group', g.id, true);
      await ws.deleteGroup(g.id);
      const state = await ws.state();
      expect(state.sessions.map((s) => [s.id, s.groupId])).toEqual([['a', null]]);
      expect(state.archived.groups).toEqual([]);
      expect(await db.getSetting('archived')).not.toContain(g.id);
    });

    test('archiving keeps the pin when saving the archive fails', async () => {
      await add('s', 'bellbird');
      await ws.setState('s', 'done');
      await ws.setPinned('session', 's', true);
      await expect(new Workspace(replacing(db, { putSetting: boom })).setArchived('session', 's', true)).rejects.toThrow('boom');
      expect(await db.listPins()).toHaveLength(1);
      expect((await ws.state()).archived.sessions).toEqual([]);
    });

    test('pinning refuses an unknown item and unpinning one not pinned changes nothing', async () => {
      let changes = 0;
      ws.onChange(() => changes++);
      await expect(ws.setPinned('project', 'nope', true)).rejects.toThrow(/No such project/);
      await expect(ws.setPinned('group', 'nope', true)).rejects.toThrow(/No such group/);
      await ws.setPinned('session', 'nope', false);
      expect(changes).toBe(0);
      await ws.setPinned('project', 'docs', true);
      expect(await db.listPins()).toMatchObject([{ kind: 'project', id: 'docs' }]);
    });

    test('deleting a workstream that does not exist is refused', async () => {
      await expect(ws.deleteWorkstream('nope')).rejects.toThrow(/No such workstream/);
    });

    test('resuming a workstream deleted meanwhile reports no change', async () => {
      await add('o', 'bellbird');
      const { workstream, children } = await ws.delegate('o', [{ projectId: 'platform', brief: 'a' }]);
      await Promise.all(['o', children[0]!.id].map((id) => ws.setState(id, 'done')));
      await ws.archiveWorkstream(workstream!.id);
      const seen = await db.listWorkstreams();
      await ws.deleteWorkstream(workstream!.id);
      const stale = new Workspace(replacing(db, { listWorkstreams: async () => seen }));
      let changes = 0;
      stale.onChange(() => changes++);
      expect(await stale.resumeWorkstreamOf(children[0]!.id)).toBe(false);
      expect(changes).toBe(0);
    });
  });
});

describe('buildTree', () => {
  test('never drops a row when links form a cycle', () => {
    const links = [
      { id: '1', parentId: 'a', childId: 'b', kind: 'handoff' as const },
      { id: '2', parentId: 'b', childId: 'a', kind: 'handoff' as const },
    ];
    const flat = (nodes: ReturnType<typeof buildTree>): string[] => nodes.flatMap((n) => [n.sessionId, ...flat(n.children)]);
    expect(flat(buildTree(['a', 'b'], links)).sort()).toEqual(['a', 'b']);
  });
});

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('rename, archive and delete on %s', (_name, makeDb) => {
  const make = async () => {
    const ws = new Workspace(makeDb());
    const project = await ws.addProject({ name: 'Wren', path: '/tmp/wren', isGit: true });
    const group = await ws.addGroup('Launch');
    const a = await ws.addSession({ title: 'First', agent: 'claude', startedIn: project.id, groupId: null, state: 'done', note: '' });
    const b = await ws.addSession({ title: 'Second', agent: 'claude', startedIn: null, groupId: group.id, state: 'done', note: '' });
    return { ws, project, group, a, b };
  };
  test('renames a session and a project, and refuses an empty name', async () => {
    const { ws, project, a } = await make();
    await ws.renameSession(a.id, '  Better name ');
    await ws.renameProject(project.id, 'Wren app');
    const state = await ws.state();
    expect(state.sessions.find((s) => s.id === a.id)!.title).toBe('Better name');
    expect(state.projects[0]!.name).toBe('Wren app');
    await expect(ws.renameSession(a.id, '   ')).rejects.toThrow(/needs a name/);
    await expect(ws.renameProject('nope', 'x')).rejects.toThrow(/No such project/);
  });
  test('keeps when a turn started and ended, and where it ends in the agent’s conversation, with the conversation', async () => {
    const { ws, a } = await make();
    const messages = [
      { id: 'u1', author: 'you' as const, time: '15:40', text: 'go', sentAt: 1_000, turnEndedAt: 135_000, forkPoint: 'uuid-1' },
      { id: 'm1', author: 'agent' as const, time: '15:42', text: 'Done.' },
    ];
    await ws.setDetail(a.id, { messages });
    expect((await ws.storedDetail(a.id))!.messages).toEqual(messages);
  });
  test('archiving a session takes it out of every list and restoring brings it back', async () => {
    const { ws, a } = await make();
    await ws.setArchived('session', a.id, true);
    let state = await ws.state();
    expect(state.sessions.map((s) => s.title)).toEqual(['Second']);
    expect(state.archived.sessions.map((s) => s.title)).toEqual(['First']);
    expect(Object.values(state.trees).flat().map((n) => n.sessionId)).not.toContain(a.id);
    await ws.setArchived('session', a.id, false);
    state = await ws.state();
    expect(state.sessions).toHaveLength(2);
    expect(state.archived.sessions).toEqual([]);
  });
  test('archiving a project or a group hides its sessions with it', async () => {
    const { ws, project, group } = await make();
    await ws.setArchived('project', project.id, true);
    await ws.setArchived('group', group.id, true);
    const state = await ws.state();
    expect(state.projects).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.archived).toMatchObject({ projects: [{ name: 'Wren' }], groups: [{ name: 'Launch' }] });
    expect(state.archived.sessions.map((s) => s.title).sort()).toEqual(['First', 'Second']);
  });
  test('a project\'s agent setup defaults to settings on and no MCP servers, and remembers what is chosen', async () => {
    const { ws, project } = await make();
    expect(await ws.projectSetup(project.id)).toEqual({ inherits: true, setup: { loadSettings: true, mcpServers: [] } });
    expect(await ws.projectSetup(null)).toEqual({ inherits: true, setup: { loadSettings: true, mcpServers: [] } });
    await ws.setProjectSetup(project.id, { loadSettings: false, mcpServers: ['notes', 'notes', 7] });
    expect(await ws.projectSetup(project.id)).toEqual({ inherits: false, setup: { loadSettings: false, mcpServers: ['notes'] } });
    await expect(ws.setProjectSetup('nope', {})).rejects.toThrow(/No such project/);
  });
  test('defaults are set once and every project follows them until it is given its own setup', async () => {
    const { ws, project } = await make();
    const other = await ws.addProject({ name: 'Other', path: '/tmp/other', isGit: true });
    await ws.setDefaultSetup({ loadSettings: true, mcpServers: ['memory', 'notes'] });
    expect((await ws.projectSetup(project.id)).setup.mcpServers).toEqual(['memory', 'notes']);
    expect((await ws.projectSetup(null)).setup.mcpServers).toEqual(['memory', 'notes']);
    // One project takes its own setup; the other still follows the defaults when they change.
    await ws.setProjectSetup(project.id, { loadSettings: true, mcpServers: ['notes'] });
    await ws.setDefaultSetup({ loadSettings: true, mcpServers: ['memory'] });
    expect(await ws.projectSetup(project.id)).toEqual({ inherits: false, setup: { loadSettings: true, mcpServers: ['notes'] } });
    expect(await ws.projectSetup(other.id)).toEqual({ inherits: true, setup: { loadSettings: true, mcpServers: ['memory'] } });
    // Back on the defaults.
    await ws.setProjectSetup(project.id, null);
    expect(await ws.projectSetup(project.id)).toEqual({ inherits: true, setup: { loadSettings: true, mcpServers: ['memory'] } });
  });
  test('refuses to archive something with a session still working', async () => {
    const { ws, project, a } = await make();
    await ws.setState(a.id, 'running');
    await expect(ws.setArchived('session', a.id, true)).rejects.toThrow(/still working/);
    await expect(ws.setArchived('project', project.id, true)).rejects.toThrow(/still working/);
  });
  test('deleting a session removes it, its links, and its place in the archive', async () => {
    const { ws, project, a } = await make();
    const child = await ws.handoff(a.id, { projectId: project.id, summary: 'carry on' });
    await ws.setArchived('session', a.id, true);
    await ws.deleteSession(a.id);
    const state = await ws.state();
    expect([...state.sessions, ...state.archived.sessions].map((s) => s.id)).not.toContain(a.id);
    expect(state.links).toEqual([]);
    expect(state.sessions.map((s) => s.id)).toContain(child.id);
    await expect(ws.deleteSession(a.id)).rejects.toThrow(/No such session/);
  });
});

// Kestrel's own MCP servers (mcp-servers/): the list through the facade on every provider, the values
// sealed apart, and which servers each kind of session is handed.
describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('MCP servers on %s', (_name, makeDb) => {
  const TOKEN = 'n8n_live_9f8e7d6c5b4a';
  const make = async () => {
    const db = makeDb();
    const ws = new Workspace(db);
    const secrets = memorySecrets();
    const store = new McpServerStore(db, secrets);
    const wren = await ws.addProject({ name: 'Wren', path: '/tmp/wren', isGit: true });
    const other = await ws.addProject({ name: 'Other', path: '/tmp/other', isGit: true });
    return { db, ws, secrets, store, wren, other };
  };
  const n8n = (over: object = {}) => ({ name: 'n8n', kind: 'http', url: 'https://n8n.example.com/mcp', headers: [{ key: 'Authorization', value: `Bearer ${TOKEN}` }], ...over });
  const none = () => [];

  test('adds, lists, changes and removes a server; its value is sealed apart and never shown', async () => {
    const { db, secrets, store } = await make();
    const added = await store.save(null, n8n());
    expect(added.headers).toEqual([{ key: 'Authorization', secret: true, set: true }]);
    expect(JSON.stringify(await store.list())).not.toContain(TOKEN);
    expect(await db.getSetting(MCP_SERVERS_KEY)).not.toContain(TOKEN);
    expect(await secrets.read()).toEqual({ n8n: { 'header:Authorization': `Bearer ${TOKEN}` } });
    // A change that leaves the secret empty keeps it.
    await store.save('n8n', n8n({ url: 'https://n8n.example.com/mcp2', headers: [{ key: 'Authorization' }] }));
    expect((await store.view('n8n')).url).toBe('https://n8n.example.com/mcp2');
    expect((await secrets.read()).n8n).toEqual({ 'header:Authorization': `Bearer ${TOKEN}` });
    await expect(store.save(null, n8n())).rejects.toThrow(/already an MCP server named n8n/);
    await expect(store.save('n8n', n8n({ name: 'n9n' }))).rejects.toThrow(/name cannot be changed/);
    await store.remove('n8n');
    expect((await store.list()).servers).toEqual([]);
    expect(await secrets.read()).toEqual({});
    await expect(store.remove('n8n')).rejects.toThrow(/No MCP server named n8n/);
  });

  test('a server for every project is switched on in the defaults and in each project’s own setup, and off when it leaves', async () => {
    const { ws, store, wren, other } = await make();
    await ws.setProjectSetup(wren.id, { loadSettings: true, mcpServers: ['notes'] });
    await store.save(null, n8n());
    expect((await ws.projectSetup(null)).setup.mcpServers).toEqual(['n8n']);
    expect((await ws.projectSetup(wren.id)).setup.mcpServers).toEqual(['notes', 'n8n']);
    expect((await ws.projectSetup(other.id)).inherits).toBe(true);
    // Moved to one project: off in every list.
    await store.save('n8n', n8n({ projectId: other.id }));
    expect((await ws.projectSetup(wren.id)).setup.mcpServers).toEqual(['notes']);
    expect((await ws.projectSetup(null)).setup.mcpServers).toEqual([]);
  });

  test('which servers each kind of session is handed', async () => {
    const { ws, store, wren, other } = await make();
    await store.save(null, n8n());
    await store.save(null, { name: 'wren-db', kind: 'stdio', command: 'wren-db-mcp', projectId: wren.id, env: [{ key: 'DB_PASSWORD', value: 'pw-1234' }] });
    await store.save(null, { name: 'feeds', kind: 'sse', url: 'https://feeds.example/sse', projectId: null });
    // Wren switches the default "feeds" off for itself.
    await ws.setProjectSetup(wren.id, { loadSettings: true, mcpServers: ['n8n'] });
    const inWren = await ws.addSession({ title: 'In Wren', agent: 'claude', startedIn: wren.id });
    const noProject = await ws.addSession({ title: 'Loose', agent: 'claude', startedIn: null });
    const review = await ws.addSession({ title: 'Review', agent: 'claude', startedIn: wren.id, review: { key: 'gh:o/r#7', host: 'github', number: 7, sha: 'abc', url: 'https://github.com/o/r/pull/7' } });
    const { children: [child] } = await ws.delegate(inWren.id, [{ projectId: other.id, title: "Child", brief: "Do it" }]);
    const names = async (id: string, project: typeof wren | null) => Object.keys((await sessionServers(ws, store, id, { project, folder: project?.folders[0] ?? null }, none)).mcpServers).sort();
    expect(await names(inWren.id, wren)).toEqual(['n8n', 'wren-db']);
    expect(await names(noProject.id, null)).toEqual(['feeds', 'n8n']);
    // A review of somebody else's pull request gets the default set, not the project's.
    expect(await names(review.id, wren)).toEqual(['feeds', 'n8n']);
    // A child in another project gets its parent's.
    expect(await names(child!.id, other)).toEqual(['n8n', 'wren-db']);
    // A spawned session is an unrelated task: its own project's, not its caller's (M9, Matt 2026-11-24).
    const spawned = await ws.spawn(inWren.id, { projectId: other.id, title: 'Unrelated' });
    expect(await names(spawned.id, other)).toEqual(['feeds', 'n8n']);
    const handed = await sessionServers(ws, store, inWren.id, { project: wren, folder: wren.folders[0] ?? null }, none);
    expect(handed.mcpServers['wren-db']).toEqual({ command: 'wren-db-mcp', args: [], env: { DB_PASSWORD: 'pw-1234' } });
    expect(JSON.stringify(handed.handed)).not.toContain('pw-1234');
  });
});
