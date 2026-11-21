// "Stopped": a session whose last turn ended because the user stopped it. Kept as a field of its own
// through every persistence provider (derived once from the note in an older sqlite store), and read
// by the one status function, which files it with finished work.
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import { countByFilter, matchesFilter, STATUS_DOT, statusLabel, statusOf } from './shared/status.ts';
import { overviewSection } from './shared/overview.ts';
import { Workspace } from './workspace.ts';

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('the stopped flag on %s', (_name, makeDb) => {
  it('is set by a done that a Stop caused and cleared by the next change of state', async () => {
    const db = makeDb();
    let tick = 1;
    const ws = new Workspace(db, () => tick++);
    await ws.addProject({ id: 'p', name: 'p', path: '/repos/p', isGit: true });
    await ws.addSession({ id: 's', title: 'S', agent: 'claude', startedIn: 'p' });
    await ws.setState('s', 'done', 'Stopped', { activity: true, stopped: true });
    const stopped = (await ws.state()).sessions.find((s) => s.id === 's')!;
    expect(stopped.stopped).toBe(true);
    expect(statusLabel(stopped)).toBe('Stopped');
    await ws.setState('s', 'running', 'Working…');
    expect((await db.getSession('s'))!.stopped).toBeFalsy();
    await ws.setState('s', 'done', 'Finished', { completed: true });
    expect(statusOf((await ws.state()).sessions.find((s) => s.id === 's')!)).toBe('done');
  });
});

describe('an older sqlite store', () => {
  it('derives the flag once from the note a stopped turn left, and not from any later note', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-stopped-')), 'kestrel.db');
    await sqlitePersistence(path).close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE sessions DROP COLUMN stopped');
    const insert = old.prepare('INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('stopped', 'A', 'claude', 'done', 'Stopped', 1, 2);
    insert.run('finished', 'B', 'claude', 'done', 'Finished · waiting for your next message', 1, 2);
    insert.run('running', 'C', 'claude', 'running', 'Stopped the server', 1, 2);
    old.close();
    let db = sqlitePersistence(path);
    expect((await db.getSession('stopped'))!.stopped).toBe(true);
    expect((await db.getSession('finished'))!.stopped).toBeUndefined();
    expect((await db.getSession('running'))!.stopped).toBeUndefined();
    await db.updateSession('finished', { note: 'Stopped' });
    await db.close();
    db = sqlitePersistence(path);
    expect((await db.getSession('finished'))!.stopped).toBeUndefined();
    await db.close();
  });
});

describe('the Stopped status', () => {
  const stopped = { state: 'done' as const, note: 'Stopped', stopped: true };

  it('is grey, finished work: under the Done chip and in Recently done, never Needs you', () => {
    expect(statusOf(stopped)).toBe('stopped');
    expect(STATUS_DOT.stopped).toBe('idle');
    expect(matchesFilter(stopped, 'done')).toBe(true);
    expect(matchesFilter(stopped, 'needs-you')).toBe(false);
    expect(countByFilter([stopped, { state: 'done', note: 'Finished' }])).toMatchObject({ done: 2, 'needs-you': 0 });
    expect(overviewSection({ ...stopped, id: 's', updatedAt: 1, lastActivityAt: 1 }, { s: 1 })).toBe('done');
  });

  it('is read from the field, never from the note; an open request still asks for review', () => {
    expect(statusOf({ state: 'done', note: 'Stopped' })).toBe('done');
    expect(statusOf({ ...stopped, request: 'open' })).toBe('review');
  });
});
