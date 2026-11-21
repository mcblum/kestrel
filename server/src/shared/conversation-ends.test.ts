import { describe, expect, it } from 'vitest';
import { drawnInPlace, isOpenNextStep, linksAtEnd, markedStarts, nextStepAtEnd } from './conversation-ends.ts';

const open = { next: { recap: 'Done.', ask: 'Post it?', replies: ['Post', 'Keep local'] } };
const spent = { next: { ...open.next, done: true } };
const recapOnly = { next: { recap: 'Done.', replies: [] } };
const text = {};

describe('a next step is drawn at the end of the turn', () => {
  it('the open one moves to the end once the turn has ended, however much was written after it', () => {
    expect(nextStepAtEnd([text, open, text, text], false)).toBe(1);
    expect(drawnInPlace(open)).toBe(false);
  });
  it('is not drawn at all while the agent is still working', () => {
    expect(nextStepAtEnd([text, open, text], true)).toBeNull();
    expect(drawnInPlace(open)).toBe(false);
  });
  it('the latest open one wins', () => {
    expect(nextStepAtEnd([open, text, open], false)).toBe(2);
  });
  it('a spent one, or one with no replies, stays where it was sent', () => {
    expect(nextStepAtEnd([text, spent, recapOnly], false)).toBeNull();
    expect([spent, recapOnly, text].map(drawnInPlace)).toEqual([true, true, true]);
    expect(isOpenNextStep(recapOnly)).toBe(false);
  });
});

describe('sessions this one started', () => {
  const links = [
    { parentId: 'p', childId: 'marked' },
    { parentId: 'p', childId: 'old-running' },
    { parentId: 'p', childId: 'old-done' },
    { parentId: 'p', childId: 'old-waiting' },
    { parentId: 'p', childId: 'gone' },
    { parentId: 'other', childId: 'x' },
  ];
  const states: Record<string, 'running' | 'done' | 'attention'> = { marked: 'running', 'old-running': 'running', 'old-done': 'done', 'old-waiting': 'attention', x: 'running' };
  const marked = markedStarts([{}, { started: { sessionId: 'marked', kind: 'delegate' } }]);

  it('are marked where they were started', () => {
    expect([...marked]).toEqual(['marked']);
  });
  it('are listed at the end only when they have no mark and are not finished', () => {
    expect(linksAtEnd(links, 'p', marked, (id) => states[id]).map((l) => l.childId)).toEqual(['old-running', 'old-waiting']);
  });
  it('never lists a fork: the user made it, this session did not start it', () => {
    expect(linksAtEnd([{ parentId: 'p', childId: 'old-running', kind: 'fork' as const }], 'p', new Set(), (id) => states[id])).toEqual([]);
  });
});
