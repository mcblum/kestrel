// Requests linked to a session, stored through every provider: linking once per host and number,
// the order they were linked, going with a deleted session, kept across a reopen, and a store written
// before links existed opening with none, and one written before links kept their request's state
// opening with it unknown. Also Workspace.recordRequests on top: new links, state updates, and
// telling listeners only when something changed.
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RequestLink } from '../model.ts';
import { Workspace } from '../workspace.ts';
import { memoryPersistence } from './memory.ts';
import { sqlitePersistence } from './sqlite.ts';
import type { Persistence } from './types.ts';

const NOW = 5_000;
const link = (number: number, branch = 'feat/a'): RequestLink => ({ host: 'github', number, url: `https://github.com/o/r/pull/${number}`, branch, linkedAt: NOW });
const tempStore = () => join(mkdtempSync(join(tmpdir(), 'kestrel-links-')), 'kestrel.sqlite');

async function withSession(db: Persistence) {
  const workspace = new Workspace(db, () => NOW);
  const session = await workspace.addSession({ title: 'S', agent: 'claude', startedIn: null });
  return { workspace, id: session.id };
}

describe.each([
  ['memory', () => memoryPersistence()],
  ['sqlite', () => sqlitePersistence()],
])('request links in %s', (_name, open) => {
  it('links a host and number once, in the order linked', async () => {
    const db = open();
    const { id } = await withSession(db);
    expect(await db.listRequestLinks(id)).toEqual([]);
    expect(await db.insertRequestLink(id, link(9))).toBe(true);
    expect(await db.insertRequestLink(id, link(3, 'feat/b'))).toBe(true);
    expect(await db.insertRequestLink(id, { ...link(9), branch: 'feat/c' })).toBe(false);
    expect(await db.insertRequestLink(id, { ...link(9), host: 'gitlab' })).toBe(true);
    expect((await db.listRequestLinks(id)).map((l) => `${l.host}:${l.number}:${l.branch}`)).toEqual(['github:9:feat/a', 'github:3:feat/b', 'gitlab:9:feat/a']);
  });

  it('refuses a link for no session, and drops them with a deleted one', async () => {
    const db = open();
    const { workspace, id } = await withSession(db);
    await expect(db.insertRequestLink('missing', link(1))).rejects.toThrow();
    await db.insertRequestLink(id, link(1));
    await workspace.deleteSession(id);
    expect(await db.listRequestLinks(id)).toEqual([]);
  });

  it('records through the workspace only the new ones, stamped with its clock', async () => {
    const db = open();
    const { workspace, id } = await withSession(db);
    const { linkedAt: _ignored, ...first } = link(1);
    expect(await workspace.recordRequests(id, [first])).toEqual([link(1)]);
    const { linkedAt: _also, ...second } = link(2, 'feat/b');
    expect(await workspace.recordRequests(id, [first, second])).toEqual([link(2, 'feat/b')]);
    expect(await workspace.requestLinks(id)).toEqual([link(1), link(2, 'feat/b')]);
    expect(await workspace.recordRequests('gone', [first])).toEqual([]);
  });

  it('keeps the state a link was last seen in, changing it only when it differs', async () => {
    const db = open();
    const { id } = await withSession(db);
    await db.insertRequestLink(id, { ...link(1), state: 'open' });
    await db.insertRequestLink(id, link(2));
    expect(await db.setRequestState(id, 'github', 1, 'open')).toBe(false);
    expect(await db.setRequestState(id, 'github', 1, 'merged')).toBe(true);
    expect(await db.setRequestState(id, 'github', 2, 'draft')).toBe(true);
    expect(await db.setRequestState(id, 'github', 3, 'open')).toBe(false);
    expect(await db.setRequestState(id, 'gitlab', 1, 'open')).toBe(false);
    expect((await db.listRequestLinks(id)).map((l) => [l.number, l.state])).toEqual([[1, 'merged'], [2, 'draft']]);
    expect((await db.listAllRequestLinks()).map((l) => [l.sessionId, l.number, l.state])).toEqual([[id, 1, 'merged'], [id, 2, 'draft']]);
  });

  it('tells listeners when a lookup adds a link or changes a state, and not otherwise', async () => {
    const db = open();
    const { workspace, id } = await withSession(db);
    let told = 0;
    workspace.onChange(() => told++);
    const { linkedAt: _ignored, ...first } = link(1);
    await workspace.recordRequests(id, [{ ...first, state: 'open' }]);
    expect(told).toBe(1);
    await workspace.recordRequests(id, [{ ...first, state: 'open' }]);
    expect(told).toBe(1);
    await workspace.recordRequests(id, [{ ...first, branch: 'feat/other', state: 'merged' }]);
    expect(told).toBe(2);
    expect(await workspace.requestLinks(id)).toEqual([{ ...link(1), state: 'merged' }]);
    await workspace.recordRequests(id, [first]); // a state not known changes nothing
    expect(told).toBe(2);
  });

  it('gives each session in the workspace state the last-seen state of its newest request', async () => {
    const db = open();
    const { workspace, id } = await withSession(db);
    const other = (await workspace.addSession({ title: 'T', agent: 'claude', startedIn: null })).id;
    const seen = (number: number, state: RequestLink['state']) => ({ host: 'github' as const, number, url: `u${number}`, branch: 'b', state });
    await workspace.recordRequests(id, [seen(3, 'open'), seen(7, 'merged')]);
    const view = (sid: string) => workspace.state().then((st) => st.sessions.find((x) => x.id === sid)!.request);
    expect(await view(id)).toBe('merged');
    expect(await view(other)).toBeNull();
    await workspace.recordRequests(id, [seen(7, 'open')]);
    expect(await view(id)).toBe('open');
  });
});

describe('request links in a SQLite file', () => {
  it('are kept across a reopen', async () => {
    const path = tempStore();
    const first = sqlitePersistence(path);
    const { id } = await withSession(first);
    await first.insertRequestLink(id, link(4));
    await first.close();
    const again = sqlitePersistence(path);
    expect(await again.listRequestLinks(id)).toEqual([link(4)]);
    await again.close();
  });

  it('open as none in a store written before they existed', async () => {
    const path = tempStore();
    const first = sqlitePersistence(path);
    const { id } = await withSession(first);
    await first.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE session_requests');
    old.close();
    const again = sqlitePersistence(path);
    expect(await again.getSession(id)).not.toBeNull();
    expect(await again.listRequestLinks(id)).toEqual([]);
    expect(await again.insertRequestLink(id, link(1))).toBe(true);
    await again.close();
  });

  it('open with their state unknown in a store written before links kept it, and keep it after', async () => {
    const path = tempStore();
    const first = sqlitePersistence(path);
    const { id } = await withSession(first);
    await first.close();
    const old = new DatabaseSync(path);
    old.exec(`
      DROP TABLE session_requests;
      CREATE TABLE session_requests (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        host TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL, branch TEXT NOT NULL, linked_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, host, number));
    `);
    old.prepare('INSERT INTO session_requests (session_id, host, number, url, branch, linked_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'github', 4, link(4).url, 'feat/a', NOW);
    old.close();
    const again = sqlitePersistence(path);
    expect(await again.listRequestLinks(id)).toEqual([link(4)]);
    expect((await new Workspace(again).state()).sessions.find((s) => s.id === id)!.request).toBeNull();
    expect(await again.setRequestState(id, 'github', 4, 'open')).toBe(true);
    await again.close();
    const reopened = sqlitePersistence(path); // the column is added once; opening again is a no-op
    expect(await reopened.listRequestLinks(id)).toEqual([{ ...link(4), state: 'open' }]);
    await reopened.close();
  });
});
