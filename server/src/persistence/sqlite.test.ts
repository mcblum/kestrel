// Stores written by older versions keep loading. Only this folder may touch node:sqlite.
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqlitePersistence } from './sqlite.ts';

describe('an older store', () => {
  it('marks each guest with its host from what its detail kept, once, and keeps the mark after a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE sessions DROP COLUMN host_id');
    const insert = old.prepare('INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const id of ['host', 'guest', 'plain', 'odd']) insert.run(id, id, 'claude', 'done', '', 1, 1);
    const detail = old.prepare('INSERT INTO session_detail (session_id, json) VALUES (?, ?)');
    detail.run('guest', JSON.stringify({ messages: [], guest: { hostId: 'host', role: 'design', writes: true } }));
    detail.run('plain', JSON.stringify({ messages: [] }));
    detail.run('odd', JSON.stringify({ messages: [], guest: { hostId: 7 } }));
    old.close();
    let db = sqlitePersistence(path);
    expect((await db.getSession('guest'))!.hostId).toBe('host');
    for (const id of ['host', 'plain', 'odd']) expect((await db.getSession(id))!.hostId).toBeUndefined();
    await db.close();
    db = sqlitePersistence(path);
    expect((await db.getSession('guest'))!.hostId).toBe('host');
    await db.close();
  });

  it('backfills completion dates once, excludes stopped sessions, and preserves them after restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE sessions DROP COLUMN completed_at');
    const insert = old.prepare('INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('done', 'Finished', 'claude', 'done', 'Finished', 1, 90, 50);
    insert.run('stopped', 'Stopped', 'claude', 'done', 'Stopped', 1, 90, 60);
    insert.run('running', 'Working', 'claude', 'running', 'Working', 1, 90, 70);
    old.close();
    let db = sqlitePersistence(path);
    expect((await db.getSession('done'))!.completedAt).toBe(50);
    expect((await db.getSession('stopped'))!.completedAt).toBeUndefined();
    expect((await db.getSession('running'))!.completedAt).toBeUndefined();
    await db.updateSession('done', { state: 'running', lastActivityAt: 100 });
    await db.close();
    db = sqlitePersistence(path);
    expect((await db.getSession('done'))!.completedAt).toBe(50);
    expect((await db.getSession('stopped'))!.completedAt).toBeUndefined();
    await db.close();
  });

  it('loads groups that still carry the removed allow_auto flag, and adds new groups beside them', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE groups ADD COLUMN allow_auto INTEGER NOT NULL DEFAULT 0');
    old.prepare('INSERT INTO groups (id, name, auto, created_at, allow_auto) VALUES (?, ?, ?, ?, ?)').run('g1', 'Trusted', 0, 1, 1);
    old.close();

    const db = sqlitePersistence(path);
    await db.insertGroup({ id: 'g2', name: 'New', auto: true, createdAt: 2 });
    expect(await db.listGroups()).toEqual([
      { id: 'g1', name: 'Trusted', auto: false, createdAt: 1, projectId: null },
      { id: 'g2', name: 'New', auto: true, createdAt: 2, projectId: null },
    ]);
    await db.close();
  });

  it('written before pins had a place keeps them in the order they were pinned, and new pins go after', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE pins; CREATE TABLE pins (kind TEXT NOT NULL, id TEXT NOT NULL, pinned_at INTEGER NOT NULL, PRIMARY KEY (kind, id))');
    const insert = old.prepare('INSERT INTO pins (kind, id, pinned_at) VALUES (?, ?, ?)');
    insert.run('group', 'g', 30);
    insert.run('session', 's', 10);
    insert.run('project', 'p', 20);
    old.close();

    const db = sqlitePersistence(path);
    expect((await db.listPins()).map((p) => p.id)).toEqual(['s', 'p', 'g']);
    await db.putPin({ kind: 'session', id: 'new', pinnedAt: 5 });
    expect((await db.listPins()).map((p) => p.id)).toEqual(['s', 'p', 'g', 'new']);
    await db.close();
  });

  it('keeps a reordered pin list across a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    const first = sqlitePersistence(path);
    for (const [i, id] of ['a', 'b', 'c'].entries()) await first.putPin({ kind: 'session', id, pinnedAt: i });
    await first.setPinOrder([{ kind: 'session', id: 'c' }, { kind: 'session', id: 'a' }, { kind: 'session', id: 'b' }]);
    await first.close();

    const again = sqlitePersistence(path);
    expect((await again.listPins()).map((p) => p.id)).toEqual(['c', 'a', 'b']);
    await again.close();
  });

  it('written before tags and pins existed opens with every session untagged and nothing pinned', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE session_tags; DROP TABLE pins');
    old.prepare("INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at) VALUES ('s1', 'Old', 'claude', 'done', '', 1, 1)").run();
    old.close();

    const db = sqlitePersistence(path);
    expect(await db.listTags()).toEqual([]);
    expect(await db.listPins()).toEqual([]);
    await db.setTags('s1', ['PLAT-1', 'infra']);
    expect(await db.tagsOf('s1')).toEqual(['PLAT-1', 'infra']);
    await db.close();
  });

  it('written before sessions kept an activity time takes its last update as one, so a later move does not change it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE sessions DROP COLUMN last_activity_at');
    old.prepare("INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at) VALUES ('s1', 'Old', 'claude', 'done', '', 1, 7)").run();
    old.close();

    const db = sqlitePersistence(path);
    expect((await db.getSession('s1'))!.lastActivityAt).toBe(7);
    await db.setSessionsGroup(['s1'], null, 30); // a move: the record changes, the activity does not
    expect((await db.getSession('s1'))!.lastActivityAt).toBe(7);
    await db.updateSession('s1', { lastActivityAt: 42 });
    await db.close();
    const again = sqlitePersistence(path);
    expect((await again.getSession('s1'))!.lastActivityAt).toBe(42);
    await again.close();
  });

  it('written before waits existed opens with none, and a wait written to it is there after reopening', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE session_waits');
    old.prepare("INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at) VALUES ('a', 'A', 'claude', 'running', '', 1, 1), ('b', 'B', 'claude', 'running', '', 1, 1)").run();
    old.prepare("INSERT INTO workstreams (id, name, objective, created_at) VALUES ('w', 'W', '', 1)").run();
    old.close();

    const db = sqlitePersistence(path);
    expect(await db.listWaits()).toEqual([]);
    const wait = { workstreamId: 'w', waiterId: 'a', targetId: 'b', reason: 'the endpoint', createdAt: 3 };
    await db.putWait(wait);
    await db.close();
    const again = sqlitePersistence(path);
    expect(await again.listWaits()).toEqual([wait]);
    await again.close();
  });
});
