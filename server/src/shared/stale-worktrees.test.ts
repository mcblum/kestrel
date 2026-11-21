import { describe, expect, test } from 'vitest';
import { bulkLoss, cleanupLine, isBulkRemoval, orderRows, rowsToRemove, reasonText, RECENTLY_USED_MS, removableInBulk, sizeText, staleReason, STALE_AFTER_DAYS, summarize, type WorktreeRow } from './stale-worktrees.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
const facts = (over = {}) => ({ state: 'done' as const, merged: false, archived: false, lastActivityAt: now - 2 * DAY, ...over });
const row = (over: Partial<WorktreeRow> = {}): WorktreeRow => ({ sessionId: 's', title: 'A', project: 'P', path: '/w', branch: 'b', bytes: 1024 ** 2, reason: null, uncommitted: 0, unmerged: 0, safe: false, lastActivityAt: now, ...over });

describe('which worktrees are suggested for cleanup', () => {
  test('a merged pull request, an archived session, or two weeks without activity', () => {
    expect(staleReason(facts({ merged: true }), now)).toBe('merged');
    expect(staleReason(facts({ archived: true }), now)).toBe('archived');
    expect(staleReason(facts({ lastActivityAt: now - STALE_AFTER_DAYS * DAY }), now)).toBe('idle');
    expect(staleReason(facts({ lastActivityAt: now - STALE_AFTER_DAYS * DAY + 1 }), now)).toBeNull();
    expect(staleReason(facts(), now)).toBeNull();
  });
  test('the strongest reason wins', () => {
    expect(staleReason(facts({ merged: true, archived: true, lastActivityAt: 0 }), now)).toBe('merged');
    expect(staleReason(facts({ archived: true, lastActivityAt: 0 }), now)).toBe('archived');
  });
  test('not a session used in the last day, even with a merged pull request, unless it is archived', () => {
    const recent = now - RECENTLY_USED_MS + 1;
    expect(staleReason(facts({ merged: true, lastActivityAt: recent }), now)).toBeNull();
    expect(staleReason(facts({ merged: true, lastActivityAt: now - RECENTLY_USED_MS }), now)).toBe('merged');
    expect(staleReason(facts({ archived: true, lastActivityAt: recent }), now)).toBe('archived');
    // Archived and merged, but just used: suggested as archived, so it is not removed with the merged ones.
    expect(staleReason(facts({ archived: true, merged: true, lastActivityAt: recent }), now)).toBe('archived');
  });
  test('never a session that is working or waiting on the user', () => {
    for (const state of ['running', 'attention'] as const) expect(staleReason(facts({ state, merged: true, archived: true, lastActivityAt: 0 }), now)).toBeNull();
    expect(staleReason(facts({ state: 'interrupted', merged: true }), now)).toBe('merged');
  });
});

describe('what loses nothing by going', () => {
  test('any suggested worktree with no uncommitted file, whatever the reason', () => {
    for (const reason of ['merged', 'archived', 'idle'] as const) expect(removableInBulk({ reason, uncommitted: 0 })).toBe(true);
  });
  test('not one with uncommitted files, one that is not suggested, or one git could not be asked about', () => {
    expect(removableInBulk({ reason: 'merged', uncommitted: 2 })).toBe(false);
    expect(removableInBulk({ reason: 'archived', uncommitted: 1 })).toBe(false);
    expect(removableInBulk({ reason: null, uncommitted: 0 })).toBe(false);
    expect(removableInBulk({ reason: 'merged', uncommitted: Number.NaN })).toBe(false);
  });
});

describe('how the list reads', () => {
  test('says why each is suggested', () => {
    expect(reasonText('merged', now, now)).toBe('Its pull request is merged');
    expect(reasonText('archived', now, now)).toBe('Its session is archived');
    expect(reasonText('idle', now, now - 20 * DAY)).toBe('No activity for 20 days');
    expect(reasonText('idle', now, now - DAY)).toBe('No activity for 1 day');
  });
  test('sizes in the unit that fits', () => {
    expect([sizeText(3.6 * 1024 ** 3), sizeText(412 * 1024 ** 2), sizeText(8 * 1024), sizeText(10)]).toEqual(['3.6 GB', '412 MB', '8 KB', '1 KB']);
  });
  test('counts what is suggested and what can go at once, and words the Overview line', () => {
    const rows = [row({ reason: 'merged', safe: true, bytes: 1024 ** 3 }), row({ reason: 'idle', bytes: 1024 ** 3 }), row({ reason: null, bytes: 5 * 1024 ** 3 }), row({ reason: 'archived', bytes: null })];
    const summary = summarize(rows);
    expect(summary).toEqual({ stale: { count: 3, bytes: 2 * 1024 ** 3 }, safe: { count: 1, bytes: 1024 ** 3 } });
    expect(cleanupLine(summary)).toBe('3 worktrees can be cleaned up (2.0 GB)');
    expect(cleanupLine(summarize([row({ reason: 'idle', bytes: null })]))).toBe('1 worktree can be cleaned up');
    expect(cleanupLine(summarize([row()]))).toBeNull();
  });
  test('lists the suggested ones first, strongest reason first, then the largest', () => {
    const rows = [row({ title: 'fresh', bytes: 9 }), row({ title: 'idle', reason: 'idle' }), row({ title: 'small', reason: 'merged', bytes: 1 }), row({ title: 'big', reason: 'merged', bytes: 5 }), row({ title: 'arch', reason: 'archived' })];
    expect(orderRows(rows).map((r) => r.title)).toEqual(['big', 'small', 'arch', 'idle', 'fresh']);
  });
});

describe('removing several at once', () => {
  const rows = [
    row({ title: 'merged', reason: 'merged', safe: true }),
    row({ title: 'dirty', reason: 'archived', uncommitted: 2 }),
    row({ title: 'old', reason: 'idle', unmerged: 4 }),
    row({ title: 'also dirty', reason: 'idle', uncommitted: 1 }),
    row({ title: 'in use', reason: null, uncommitted: 9 }),
  ];
  test('"safe" takes only what loses nothing; "stale" takes every suggested one and never one in use', () => {
    expect(rowsToRemove(rows, 'safe').map((r) => r.title)).toEqual(['merged']);
    expect(rowsToRemove(rows, 'stale').map((r) => r.title)).toEqual(['merged', 'dirty', 'old', 'also dirty']);
  });
  test('says what removing every suggested one loses: the uncommitted files, by session; never the one in use', () => {
    expect(bulkLoss(rows)).toEqual({ files: 3, sessions: ['dirty', 'also dirty'] });
    expect(bulkLoss([rows[0]!, rows[2]!])).toEqual({ files: 0, sessions: [] });
  });
  test('only the two kinds are accepted', () => {
    expect([isBulkRemoval('safe'), isBulkRemoval('stale'), isBulkRemoval('all'), isBulkRemoval(undefined)]).toEqual([true, true, false, false]);
  });
});
