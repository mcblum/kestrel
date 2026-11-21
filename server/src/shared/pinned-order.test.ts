import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../model.ts';
import type { PinnedRow } from './pinned-homes.ts';
import { orderPinned } from './pinned-order.ts';
import type { Timed } from './session-order.ts';

const node = (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: null, movedFrom: null, children });
const pinS = (id: string, children: TreeNode[] = []): PinnedRow => ({ kind: 'session', id, node: node(id, children) });
const pinG = (id: string): PinnedRow => ({ kind: 'group', id });
const pinP = (id: string): PinnedRow => ({ kind: 'project', id });
const t = (id: string, at: number, createdAt = 0): Timed => ({ id, createdAt, updatedAt: 0, lastActivityAt: at });
const lookupOf = (sessions: readonly Timed[]) => {
  const byId = new Map(sessions.map((x) => [x.id, x]));
  return (id: string) => byId.get(id);
};
const keys = (rows: readonly PinnedRow[]) => rows.map((r) => `${r.kind}:${r.id}`);

describe('PINNED in custom order', () => {
  it('keeps the dragged order', () => {
    const rows = [pinS('a'), pinS('b')];
    expect(orderPinned(rows, 'custom', lookupOf([t('a', 1), t('b', 9)]))).toBe(rows);
  });
});

describe('PINNED most recent first', () => {
  it('moves the session just worked on to the top', () => {
    const rows = [pinS('a'), pinS('b'), pinS('c')];
    expect(keys(orderPinned(rows, 'recent', lookupOf([t('a', 30), t('b', 20), t('c', 99)])))).toEqual(['session:c', 'session:a', 'session:b']);
  });

  it('places a pinned session by the newest activity under it', () => {
    const rows = [pinS('a'), pinS('b', [node('kid')])];
    expect(keys(orderPinned(rows, 'recent', lookupOf([t('a', 50), t('b', 10), t('kid', 80)])))).toEqual(['session:b', 'session:a']);
  });

  it('never moves a pinned project or group: sessions are sorted into the places between them', () => {
    const rows = [pinP('p'), pinS('a'), pinG('g'), pinS('b'), pinS('c')];
    const lookup = lookupOf([t('a', 10), t('b', 30), t('c', 20), t('in-p', 999), t('in-g', 999)]);
    expect(keys(orderPinned(rows, 'recent', lookup))).toEqual(['project:p', 'session:b', 'group:g', 'session:c', 'session:a']);
  });

  it('puts a session it knows nothing about after the others', () => {
    const rows = [pinS('gone'), pinS('a')];
    expect(keys(orderPinned(rows, 'recent', lookupOf([t('a', 1)])))).toEqual(['session:a', 'session:gone']);
  });

  it('breaks ties on creation, then on the pin', () => {
    const rows = [pinS('a'), pinS('b'), pinS('c')];
    expect(keys(orderPinned(rows, 'recent', lookupOf([t('a', 5, 1), t('b', 5, 2), t('c', 5, 2)])))).toEqual(['session:b', 'session:c', 'session:a']);
  });

  it('returns the rows given when nothing moved', () => {
    const rows = [pinP('p'), pinS('a'), pinS('b')];
    expect(orderPinned(rows, 'recent', lookupOf([t('a', 9), t('b', 1)]))).toBe(rows);
  });
});
