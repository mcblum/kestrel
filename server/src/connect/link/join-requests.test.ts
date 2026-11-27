// The requests to join that a desktop's window is pushed (issue 72): the window draws the request's card over
// whatever page is open, so the list must change by itself when a request arrives, is answered on another device,
// is withdrawn, or runs out. AccountJoin as a device that holds the key, with no service and no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newIdentity } from '../keys.ts';
import { AccountJoin } from './join.ts';
import type { JoinApi, JoinRequest } from './join-api.ts';

const MINUTE = 60_000;

function desk(open: JoinRequest[] = []) {
  const identity = newIdentity();
  let changes = 0;
  const listed = { open };
  const api = { list: async () => listed.open, end: async () => undefined } as unknown as JoinApi;
  const join = new AccountJoin({
    api: () => api,
    me: () => ({ id: 'desk-1', name: 'Desk', kind: 'desktop', identity }),
    keys: { ready: () => ({}), grant: async () => ({ generation: 1, keyringVersion: 1 }), acceptFrom: async () => undefined, discardCopy: async () => undefined, sync: async () => undefined },
    hello: () => undefined,
    changed: () => void (changes += 1),
  });
  return { join, listed, changes: () => changes };
}

const asking = (id: string, expiresIn = 10 * MINUTE): JoinRequest => ({ id, device: { id: `device-${id}`, name: 'kestrel-node01', kind: 'node' }, commitment: 'c', createdAt: Date.now(), expiresAt: Date.now() + expiresIn });

describe('the requests to join a window is pushed', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-27T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('a request that arrives is listed at once, waiting, and the window is told', () => {
    const d = desk();
    d.join.noticed(asking('j1'));
    expect(d.changes()).toBe(1);
    expect(d.join.requests()).toEqual([expect.objectContaining({ id: 'j1', name: 'kestrel-node01', kind: 'node', state: 'waiting' })]);
  });

  it('this device’s own request is never listed', () => {
    const d = desk();
    d.join.noticed({ ...asking('mine'), device: { id: 'desk-1', name: 'Desk', kind: 'desktop' } });
    expect(d.join.requests()).toEqual([]);
  });

  it('answered on another device: the service ends it, and it goes', () => {
    const d = desk();
    d.join.noticed(asking('j1'));
    d.join.ended('j1');
    expect(d.join.requests()).toEqual([]);
    expect(d.changes()).toBe(2);
  });

  it('answered elsewhere after the person opened it here: it goes too', () => {
    const d = desk();
    d.join.noticed(asking('j1'));
    d.join.open('j1');
    expect(d.join.requests()[0]).toMatchObject({ state: 'opening' });
    d.join.ended('j1');
    expect(d.join.requests()).toEqual([]);
  });

  it('withdrawn while this computer was not listening: the next read of the list drops it', async () => {
    const d = desk([asking('j1')]);
    await d.join.refresh();
    expect(d.join.requests()).toHaveLength(1);
    d.listed.open = [];
    await d.join.refresh();
    expect(d.join.requests()).toEqual([]);
  });

  it('a request nobody answers runs out: it goes, and the window is told when it does', () => {
    const d = desk();
    d.join.noticed(asking('j1', 5 * MINUTE));
    const before = d.changes();
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(d.changes()).toBe(before);
    vi.advanceTimersByTime(1);
    expect(d.changes()).toBe(before + 1);
    expect(d.join.requests()).toEqual([]);
  });

  it('one read from the list on connecting runs out the same way', async () => {
    const d = desk([asking('j1', 2 * MINUTE)]);
    await d.join.refresh();
    const before = d.changes();
    vi.advanceTimersByTime(2 * MINUTE);
    expect(d.changes()).toBe(before + 1);
    expect(d.join.requests()).toEqual([]);
  });

  it('signing out forgets them, and a timer left over tells nothing', () => {
    const d = desk();
    d.join.noticed(asking('j1'));
    d.join.reset();
    const before = d.changes();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(d.changes()).toBe(before);
    expect(d.join.requests()).toEqual([]);
  });
});
