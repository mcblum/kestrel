import { describe, expect, it } from 'vitest';
import { markSeen, rowDot, sanitizeSeen, seenAll, sessionDot, summaryDot } from './unread.ts';

describe('the dot beside a session', () => {
  it('is yellow while the agent waits for an answer, looked at or not', () => {
    expect(rowDot('attention', 10, undefined)).toBe('needs-you');
    expect(rowDot('attention', 10, 10)).toBe('needs-you');
  });
  it('is green when it finished since the user last looked, and gone once looked at', () => {
    expect(rowDot('done', 10, 5)).toBe('unread');
    expect(rowDot('done', 10, undefined)).toBe('unread');
    expect(rowDot('done', 10, 10)).toBe('none');
    expect(rowDot('interrupted', 12, 10)).toBe('unread');
  });
  it('reads a session against the record, with nothing unread before the first run', () => {
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 10 }, { a: 5 })).toBe('unread');
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 10 }, { a: 10 })).toBe('none');
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 10 }, {})).toBe('unread');
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 10 }, null)).toBe('none');
  });
  it('goes by activity, so a move, rename or tag does not make a looked-at session green', () => {
    // Moved into a group after it was looked at: updatedAt moved on, activity did not.
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 20, lastActivityAt: 10 }, { a: 10 })).toBe('none');
    // A turn ended after the look.
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 30, lastActivityAt: 30 }, { a: 10 })).toBe('unread');
    // Looked at before this rule, when the record held updatedAt: still not green.
    expect(sessionDot({ id: 'a', state: 'done', updatedAt: 20, lastActivityAt: 10 }, { a: 20 })).toBe('none');
  });
  it('shows working while the agent is busy', () => {
    expect(rowDot('running', 10, 3)).toBe('working');
  });
  it('rolls up to a project or group: yellow wins over green', () => {
    expect(summaryDot(['none', 'unread', 'needs-you'])).toBe('needs-you');
    expect(summaryDot(['working', 'unread'])).toBe('unread');
    expect(summaryDot(['working', 'none'])).toBe('none');
  });
});

describe('remembering what was looked at', () => {
  it('records a look and leaves the object alone when nothing changed', () => {
    const seen = markSeen({}, { id: 'a', updatedAt: 9, lastActivityAt: 4 });
    expect(seen).toEqual({ a: 4 });
    expect(markSeen(seen, { id: 'a', updatedAt: 12, lastActivityAt: 4 })).toBe(seen);
  });
  it('treats everything present on first run as looked at', () => {
    expect(seenAll([{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 5, lastActivityAt: 2 }])).toEqual({ a: 1, b: 2 });
  });
  it('keeps only well-formed stored entries, and only for sessions that still exist', () => {
    expect(sanitizeSeen({ a: 1, b: 'x', c: 3 }, new Set(['a']))).toEqual({ a: 1 });
    expect(sanitizeSeen([1, 2])).toEqual({});
    expect(sanitizeSeen(null)).toEqual({});
  });
});
