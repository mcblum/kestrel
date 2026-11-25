import { describe, expect, it } from 'vitest';
import { OpencodeMidTurn } from './mid-turn.ts';

const user = (id: string) => ({ type: 'message.updated', properties: { info: { id, role: 'user' } } });
const step = (id: string, parentID: string) => ({ type: 'message.updated', properties: { info: { id, role: 'assistant', parentID } } });

describe('OpenCode messages sent into a running turn', () => {
  it('matches them to OpenCode user messages after the turn’s own prompt, in order, and reads them by parentID', () => {
    const m = new OpencodeMidTurn();
    m.beginTurn();
    expect(m.promptSeen).toBe(false);
    expect(m.see(user('u0'))).toEqual([]);
    expect(m.promptSeen).toBe(true);
    m.sent('a');
    m.sent('b');
    m.see(user('u1'));
    m.see(user('u1')); // repeated update of the same message
    m.see(user('u2'));
    expect(m.see(step('s1', 'u0'))).toEqual([]);
    // A step answering the later message has read the earlier one too.
    expect(m.see(step('s2', 'u2'))).toEqual(['a', 'b']);
    expect(m.waiting).toBe(false);
  });

  it('gives back what was never read, and forgets a message OpenCode refused', () => {
    const m = new OpencodeMidTurn();
    m.see(user('u0'));
    m.sent('a');
    m.sent('b');
    m.dropped('b');
    m.sent('c');
    m.see(user('u1'));
    expect(m.waiting).toBe(true);
    expect(m.unread()).toEqual(['a', 'c']);
    expect(m.waiting).toBe(false);
  });
});
