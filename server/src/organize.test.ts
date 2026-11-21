// Tags on sessions and pins, on every provider behind the facade.
import { beforeEach, describe, expect, test } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import type { Persistence } from './persistence/types.ts';
import { Refused, Workspace } from './workspace.ts';

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('organizing on %s', (_name, makeDb) => {
  let db: Persistence;
  let ws: Workspace;

  beforeEach(async () => {
    db = makeDb();
    ws = new Workspace(db);
    for (const id of ['bellbird', 'platform']) await ws.addProject({ id, name: id, path: `/repos/${id}`, isGit: true });
    await ws.addSession({ id: 'p', title: 'Parent', agent: 'claude', startedIn: 'bellbird' });
  });

  const tagsOf = async (id: string) => (await ws.state()).sessions.find((s) => s.id === id)!.tags;

  describe('tags', () => {
    test('a session starts with none, and shows the tags added in order, as first typed', async () => {
      expect(await tagsOf('p')).toEqual([]);
      expect(await ws.tagSession('p', ' PLAT-1234 ')).toEqual(['PLAT-1234']);
      expect(await ws.tagSession('p', 'release   train')).toEqual(['PLAT-1234', 'release train']);
      expect(await ws.tagSession('p', 'plat-1234')).toEqual(['PLAT-1234', 'release train']); // no duplicate, first case kept
      expect(await tagsOf('p')).toEqual(['PLAT-1234', 'release train']);
    });

    test('come off in any case', async () => {
      await ws.tagSession('p', 'PLAT-1234');
      await ws.tagSession('p', 'infra');
      expect(await ws.untagSession('p', 'plat-1234')).toEqual(['infra']);
      expect(await ws.untagSession('p', 'not there')).toEqual(['infra']);
      expect(await tagsOf('p')).toEqual(['infra']);
    });

    test('a bad tag or a missing session is refused with a reason', async () => {
      await expect(ws.tagSession('p', '   ')).rejects.toThrow(Refused);
      await expect(ws.tagSession('p', 'x'.repeat(41))).rejects.toThrow(/at most 40/);
      await expect(ws.tagSession('missing', 'x')).rejects.toThrow(/No such session/);
    });

    test('go with a deleted session', async () => {
      await ws.tagSession('p', 'infra');
      await ws.deleteSession('p');
      expect(await db.listTags()).toEqual([]);
    });
  });

  describe('a child starts with its parent’s tags', () => {
    beforeEach(async () => {
      await ws.tagSession('p', 'PLAT-1234');
      await ws.tagSession('p', 'infra');
    });

    test('by handoff (also the manual Move to project)', async () => {
      const child = await ws.handoff('p', { projectId: 'platform', summary: 'Carry on there' });
      expect(await tagsOf(child.id)).toEqual(['PLAT-1234', 'infra']);
    });

    test('by spawn', async () => {
      const child = await ws.spawn('p', { projectId: 'platform', title: 'Unrelated' });
      expect(await tagsOf(child.id)).toEqual(['PLAT-1234', 'infra']);
    });

    test('by delegate, every child', async () => {
      const { children } = await ws.delegate('p', [{ projectId: 'platform', brief: 'a' }, { projectId: 'bellbird', brief: 'b' }]);
      for (const c of children) expect(await tagsOf(c.id)).toEqual(['PLAT-1234', 'infra']);
    });

    test('copied once: tagging the parent later does not reach the child, nor the other way', async () => {
      const child = await ws.spawn('p', { projectId: 'platform', title: 'Unrelated' });
      await ws.tagSession('p', 'later');
      await ws.untagSession(child.id, 'infra');
      expect(await tagsOf(child.id)).toEqual(['PLAT-1234']);
      expect(await tagsOf('p')).toEqual(['PLAT-1234', 'infra', 'later']);
    });

    test('an untagged parent gives none', async () => {
      await ws.addSession({ id: 'bare', title: 'Bare', agent: 'claude', startedIn: 'bellbird' });
      const child = await ws.spawn('bare', { projectId: 'platform', title: 'x' });
      expect(await tagsOf(child.id)).toEqual([]);
    });
  });

  describe('pins', () => {
    const pins = async () => (await ws.state()).pins.map((p) => `${p.kind}:${p.id}`);

    test('a session, a project and a group pin in the order pinned, and unpin', async () => {
      const g = await ws.addGroup('Launch', { id: 'g' });
      await ws.setPinned('project', 'platform', true);
      await ws.setPinned('session', 'p', true);
      await ws.setPinned('group', g.id, true);
      await ws.setPinned('project', 'platform', true); // already pinned: keeps its place
      expect(await pins()).toEqual(['project:platform', 'session:p', 'group:g']);
      await ws.setPinned('session', 'p', false);
      expect(await pins()).toEqual(['project:platform', 'group:g']);
      await ws.setPinned('session', 'p', false); // not pinned: nothing happens
    });

    test('pinning something that does not exist is refused', async () => {
      await expect(ws.setPinned('group', 'missing', true)).rejects.toThrow(/No such group/);
    });

    test('deleting or archiving a pinned item takes its pin off; restoring does not pin it again', async () => {
      const g = await ws.addGroup('Launch', { id: 'g' });
      await ws.addSession({ id: 'q', title: 'Q', agent: 'claude', startedIn: 'platform', state: 'done' });
      for (const [kind, id] of [['session', 'p'], ['session', 'q'], ['group', 'g'], ['project', 'bellbird']] as const) await ws.setPinned(kind, id, true);
      await ws.setArchived('session', 'q', true);
      await ws.deleteGroup(g.id);
      await ws.deleteSession('p');
      await ws.removeProject('bellbird');
      expect(await db.listPins()).toEqual([]);
      await ws.setArchived('session', 'q', false);
      expect(await pins()).toEqual([]);
    });

    test('reorder: the pins take the order given; a new pin goes to the end', async () => {
      const g = await ws.addGroup('Launch', { id: 'g' });
      await ws.setPinned('session', 'p', true);
      await ws.setPinned('project', 'platform', true);
      await ws.setPinned('group', g.id, true);
      await ws.setPinOrder([{ kind: 'group', id: 'g' }, { kind: 'session', id: 'p' }, { kind: 'project', id: 'platform' }]);
      expect(await pins()).toEqual(['group:g', 'session:p', 'project:platform']);
      await ws.setPinned('project', 'bellbird', true);
      expect(await pins()).toEqual(['group:g', 'session:p', 'project:platform', 'project:bellbird']);
      await ws.setPinned('session', 'p', false);
      await ws.setPinned('session', 'p', true); // pinned again: at the end, not its old place
      expect(await pins()).toEqual(['group:g', 'project:platform', 'project:bellbird', 'session:p']);
    });

    test('reorder is refused unless it lists exactly the pins in sight', async () => {
      await ws.setPinned('session', 'p', true);
      await ws.setPinned('project', 'platform', true);
      await expect(ws.setPinOrder([{ kind: 'session', id: 'p' }])).rejects.toBeInstanceOf(Refused);
      await expect(ws.setPinOrder([{ kind: 'session', id: 'p' }, { kind: 'project', id: 'bellbird' }])).rejects.toBeInstanceOf(Refused);
      expect(await pins()).toEqual(['session:p', 'project:platform']);
    });

    test('reordering the pins in sight leaves a pin out of sight in its place', async () => {
      await ws.addSession({ id: 'in', title: 'In', agent: 'claude', startedIn: 'platform', state: 'done' });
      await ws.setPinned('session', 'p', true);
      await ws.setPinned('session', 'in', true);
      await ws.setPinned('project', 'bellbird', true);
      await ws.setArchived('project', 'platform', true); // 'in' goes out of sight, still pinned
      await ws.setPinOrder([{ kind: 'project', id: 'bellbird' }, { kind: 'session', id: 'p' }]);
      await ws.setArchived('project', 'platform', false);
      expect(await pins()).toEqual(['project:bellbird', 'session:in', 'session:p']);
    });

    test('a pin inside an archived project is out of sight until the project is restored', async () => {
      await ws.addSession({ id: 'in', title: 'In', agent: 'claude', startedIn: 'platform', state: 'done' });
      await ws.setPinned('session', 'in', true);
      await ws.setArchived('project', 'platform', true);
      expect(await pins()).toEqual([]);
      await ws.setArchived('project', 'platform', false);
      expect(await pins()).toEqual(['session:in']);
    });
  });
});
