// The account's record of what was seen (account-seen.ts): per session, the later mark wins, whichever computer
// made it, and marking unread is a mark like any other.
import { describe, expect, it } from 'vitest';
import { asMarks, asSeenRecord, laterMark, MAX_MARKS, mergeMarks, pruneMarks, seenOfMarks, seenRecordOf, type SeenMark } from './account-seen.ts';

describe('merging what was seen', () => {
  it('takes the later mark, whichever record it is in', () => {
    expect(laterMark([10, 100], [20, 50])).toEqual([10, 100]);
    expect(laterMark([10, 50], [20, 100])).toEqual([20, 100]);
    expect(laterMark(undefined, [1, 2])).toEqual([1, 2]);
    expect(laterMark([1, 2], undefined)).toEqual([1, 2]);
  });

  it('on the same moment, keeps the mark that says more was read', () => {
    const a: SeenMark = [0, 70];
    const b: SeenMark = [30, 70];
    expect(laterMark(a, b)).toBe(b);
    expect(laterMark(b, a)).toBe(b);
  });

  it('lets two computers marking different sessions at once both win', () => {
    const laptop = { s1: [10, 1000] as SeenMark, s2: [5, 1] as SeenMark };
    const mini = { s2: [20, 1000] as SeenMark, s3: [7, 1000] as SeenMark };
    expect(seenOfMarks(mergeMarks([laptop, mini]))).toEqual({ s1: 10, s2: 20, s3: 7 });
    // Order does not matter.
    expect(mergeMarks([mini, laptop])).toEqual(mergeMarks([laptop, mini]));
  });

  it('carries marking unread to every computer, until a later look', () => {
    const laptop = { s1: [10, 100] as SeenMark };
    const mini = { s1: [0, 200] as SeenMark };
    expect(seenOfMarks(mergeMarks([laptop, mini]))).toEqual({ s1: 0 });
    expect(seenOfMarks(mergeMarks([{ s1: [10, 300] }, mini]))).toEqual({ s1: 10 });
  });

  it('drops sessions that are nowhere, and keeps the newest marks past the limit', () => {
    const marks = { s1: [1, 1] as SeenMark, s2: [2, 2] as SeenMark };
    expect(pruneMarks(marks, new Set(['s1', 's2']))).toBe(marks);
    expect(pruneMarks(marks, new Set(['s2']))).toEqual({ s2: [2, 2] });
    const many = Object.fromEntries(Array.from({ length: MAX_MARKS + 3 }, (_, i) => [`s${i}`, [i, i] as SeenMark]));
    const kept = pruneMarks(many, new Set(Object.keys(many)));
    expect(Object.keys(kept)).toHaveLength(MAX_MARKS);
    expect(kept.s0).toBeUndefined();
    expect(kept[`s${MAX_MARKS + 2}`]).toEqual([MAX_MARKS + 2, MAX_MARKS + 2]);
  });

  it('reads only well-formed marks and records from another computer', () => {
    expect(asMarks({ s1: [1, 2], s2: [1], s3: 'x', s4: [-1, 2], s5: [1, Infinity] })).toEqual({ s1: [1, 2] });
    expect(asMarks(null)).toEqual({});
    const record = seenRecordOf({ id: 'mini-1', name: 'Mac mini' }, { s1: [1, 2] });
    expect(asSeenRecord(JSON.parse(JSON.stringify(record)))).toEqual({ machineId: 'mini-1', marks: { s1: [1, 2] } });
    expect(asSeenRecord({ ...record, kind: 'project' })).toBeNull();
    expect(asSeenRecord({ ...record, machine: {} })).toBeNull();
  });
});
