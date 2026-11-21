import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model.ts';
import { longConversation } from '../seed-long.ts';
import { conversationRows, estimateRowHeight, shareRows, type ConversationRow } from './conversation-rows.ts';

const T0 = 1_700_000_000_000;
const you = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, author: 'you', time: '', text, sentAt: T0, ...over });
const agent = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, author: 'agent', time: '', text, ...over });
const allowed = (id: string): ChatMessage => agent(id, '', { input: { id: `card-${id}`, kind: 'approval', title: 'Run a command', detail: 'ls', tool: 'Bash', options: [{ id: 'a', label: 'Allow', role: 'allow' }], resolved: 'Allow' } });
const steps = (id: string): ChatMessage => agent(id, '', { activity: [{ id: `s-${id}`, icon: 'terminal', text: 'ls', status: 'done' }] });

const kinds = (rows: readonly ConversationRow[]) => rows.map((r) => `${r.kind}:${r.index}`);

describe('conversationRows', () => {
  it('gives each drawn message a row, a fold one row where it starts, and none to folded messages', () => {
    const messages = [you('u', 'Go', { turnEndedAt: T0 + 1000 }), agent('t', 'Testing.', { activity: [{ icon: 'terminal', text: 'tap' }] }), allowed('a1'), steps('s1'), allowed('a2')];
    const rows = conversationRows(messages, false);
    expect(kinds(rows)).toEqual(['message:0', 'message:1', 'fold:2', 'place:4']);
    expect(rows[1]).toMatchObject({ kind: 'message', textOnly: true });
    // The turn's footer stands at its last message, which is folded: a place row carries it.
    expect(rows[3]!.footer?.at).toBe(4);
  });

  it('keys rows by message id, so they stay the same as messages arrive', () => {
    const rows = conversationRows([you('u', 'Hi'), agent('r', 'Hello')], true);
    expect(rows.map((r) => r.key)).toEqual(['u', 'r']);
  });

  it('marks the row the sub-agent card sits under, but not the last message (the card goes after the list)', () => {
    const messages = [you('u', 'Hi'), agent('r', 'Hello'), agent('r2', 'More')];
    expect(conversationRows(messages, true, 1).map((r) => r.anchored)).toEqual([false, true, false]);
    expect(conversationRows(messages, true, 2).some((r) => r.anchored)).toBe(false);
  });

  it('leaves an open next step out of its place (it is drawn at the end)', () => {
    const messages = [you('u', 'Hi'), agent('n', '', { next: { recap: 'Done', replies: ['Yes'] } }), agent('r', 'Bye')];
    expect(kinds(conversationRows(messages, false))).toEqual(['message:0', 'message:2']);
  });
});

describe('shareRows', () => {
  it('keeps every other row the same object while the last message streams', () => {
    const base = longConversation(50);
    const streaming = agent('streaming', 'The slow', { streaming: true });
    const asked = you('q', 'Next');
    const before = shareRows([], conversationRows([...base, asked, streaming], true));
    const grown = { ...streaming, text: 'The slow path' };
    const after = shareRows(before, conversationRows([...base, asked, grown], true));
    const changed = after.filter((row, i) => row !== before[i]);
    expect(changed.map((r) => r.key)).toEqual(['streaming']);
  });

  it('keeps every footer’s fork data the same object while another message streams, and changes it only when the turn’s does', () => {
    const base = longConversation(50);
    const streaming = agent('streaming', 'The slow', { streaming: true });
    const before = shareRows([], conversationRows([...base, you('q', 'Next'), streaming], true));
    const after = shareRows(before, conversationRows([...base, you('q', 'Next'), { ...streaming, text: 'The slow path' }], true));
    const footers = (rows: readonly ConversationRow[]) => rows.filter((r) => r.footer).map((r) => r.footer!.fork);
    expect(footers(before).length).toBeGreaterThan(10);
    footers(after).forEach((fork, i) => expect(fork).toBe(footers(before)[i]));
    // A point arriving for a turn draws its footer's row again (its Fork is now enabled), and no other footer.
    const turn = footers(before)[0]!.turn!;
    const pointed = base.map((m) => (m.id === turn ? { ...m, forkPoint: 'p' } : m));
    const withPoint = shareRows(after, conversationRows([...pointed, you('q', 'Next'), { ...streaming, text: 'The slow path' }], true));
    const redrawn = withPoint.filter((row, i) => row !== after[i]);
    expect(redrawn.filter((r) => r.footer).map((r) => r.footer!.fork)).toEqual([{ turn, latest: false, point: true }]);
  });

  it('returns the same list when nothing changed', () => {
    const messages = longConversation(10);
    const before = shareRows([], conversationRows(messages, false));
    expect(shareRows(before, conversationRows([...messages], false))).toBe(before);
  });

  it('draws a fold again when one of the messages it reads changes, and only then', () => {
    const messages = [you('u', 'Go'), agent('t', 'Testing.'), allowed('a1'), steps('s1'), allowed('a2'), you('u2', 'Again'), agent('r', 'Ok')];
    const before = shareRows([], conversationRows(messages, true));
    const elsewhere = shareRows(before, conversationRows([...messages.slice(0, 6), agent('r', 'Ok, done')], true));
    expect(elsewhere[2]).toBe(before[2]);
    const inFold = shareRows(before, conversationRows([...messages.slice(0, 3), steps('s1'), ...messages.slice(4)], true));
    expect(inFold[2]).not.toBe(before[2]);
  });
});

describe('the long sample', () => {
  it('has about a thousand messages, folds and footers', () => {
    const messages = longConversation();
    const rows = conversationRows(messages, false);
    expect(messages).toHaveLength(1000);
    expect(rows.some((r) => r.kind === 'fold')).toBe(true);
    expect(rows.filter((r) => r.footer).length).toBe(250);
    expect(rows.every((r) => estimateRowHeight(r) > 0)).toBe(true);
  });
});
