import { describe, expect, it } from 'vitest';
import { groupArchived, matchingArchivedGroups, workstreamArchiveDetail } from './archived-rows.ts';

const row = (kind: string, id: string, name: string, restore = true) => ({ kind, id, name, detail: '', restore });
const rows = [
  row('workstream', 'w1', 'Checkout latency'),
  row('workstream', 'w2', 'Search rewrite'),
  row('project', 'p', 'Field notes'),
  row('session', 's1', 'Cache pricing'),
  row('session', 's2', 'Checkout is slow'),
  row('session', 's3', 'Index the catalogue'),
  row('session', 's9', 'Unrelated fix'),
];
const workstreams = [
  { id: 'w1', sessionIds: ['s2', 's1'] },
  { id: 'w2', sessionIds: ['s3', 's4'] },
];
const shape = (groups: ReturnType<typeof groupArchived<(typeof rows)[number]>>) => groups.map((g) => [g.row.id, g.under.map((u) => u.id), g.restoreWith]);

describe('the archived list, grouped by workstream', () => {
  it('lists an archived workstream’s archived sessions under it, in the workstream’s order, and nowhere else', () => {
    expect(shape(groupArchived(rows, workstreams))).toEqual([
      ['w1', ['s2', 's1'], ['s2', 's1']],
      ['w2', ['s3'], []],
      ['p', [], []],
      ['s9', [], []],
    ]);
  });

  it('restores the sessions with the workstream only when every one of them is archived and can be restored itself', () => {
    const hidden = rows.map((r) => (r.id === 's1' ? { ...r, restore: false } : r));
    expect(groupArchived(hidden, workstreams)[0]).toMatchObject({ under: [{ id: 's2' }, { id: 's1' }], restoreWith: [] });
    // One session of w2 is not archived: restoring the workstream alone already brings it back in sight.
    expect(groupArchived(rows, workstreams)[1]!.restoreWith).toEqual([]);
  });

  it('leaves a session alone when its workstream is not archived', () => {
    expect(shape(groupArchived(rows, []))).toEqual(rows.map((r) => [r.id, [], []]));
  });

  it('says how many of a workstream’s sessions are archived', () => {
    expect(workstreamArchiveDetail(3, 0, false)).toBe('3 sessions');
    expect(workstreamArchiveDetail(1, 0, true)).toBe('1 session · complete');
    expect(workstreamArchiveDetail(3, 2, false)).toBe('2 of 3 sessions archived');
    expect(workstreamArchiveDetail(3, 3, true)).toBe('3 sessions, all archived · complete');
    expect(workstreamArchiveDetail(1, 1, false)).toBe('1 session, archived');
  });
});

describe('searching the grouped archived list', () => {
  const groups = groupArchived(rows, workstreams);
  const found = (query: string) => matchingArchivedGroups(groups, query).map((g) => [g.row.id, g.under.map((u) => u.id)]);

  it('shows everything when nothing is typed', () => {
    expect(matchingArchivedGroups(groups, '  ')).toEqual(groups);
  });

  it('a workstream that matches keeps all its sessions', () => {
    expect(found('latency')).toEqual([['w1', ['s2', 's1']]]);
  });

  it('a session that matches shows under its workstream, without the ones that do not', () => {
    expect(found('pricing')).toEqual([['w1', ['s1']]]);
    expect(found('unrelated')).toEqual([['s9', []]]);
  });

  it('still restores every session with the workstream when only some are shown', () => {
    expect(matchingArchivedGroups(groups, 'pricing')[0]!.restoreWith).toEqual(['s2', 's1']);
  });
});
