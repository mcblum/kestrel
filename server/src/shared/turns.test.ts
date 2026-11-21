import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model.ts';
import { durationText, endTurn, markForkPoint, turnFooters, turnSpans } from './turns.ts';

const you = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `u-${text}`, author: 'you', time: '10:00', text, ...extra });
const agent = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `a-${text}`, author: 'agent', time: '10:00', text, ...extra });
const steps = (id: string): ChatMessage => ({ id, author: 'agent', time: '10:00', text: '', activity: [{ id, icon: 'terminal', text: 'Run', status: 'done' }] });

describe('where turns begin and end', () => {
  it('starts a turn at each user message and runs it to the next', () => {
    const messages = [you('one'), agent('a'), steps('s'), you('two'), agent('b')];
    expect(turnSpans(messages)).toEqual([
      { start: 0, replies: 1, end: 2 },
      { start: 3, replies: 4, end: 4 },
    ]);
  });

  it('does not start a turn at a message the user sent into the running one', () => {
    const messages = [you('one', { sentAt: 1 }), agent('a'), you('also', { sentAt: 2, midTurn: 'sent' }), agent('b'), you('two', { sentAt: 3 }), agent('c')];
    expect(turnSpans(messages)).toEqual([
      { start: 0, replies: 1, end: 3 },
      { start: 4, replies: 5, end: 5 },
    ]);
    // The turn's end is stamped on its starter, not on the message sent into it.
    expect(endTurn(messages.slice(0, 4), 9)!.index).toBe(0);
    expect(markForkPoint(messages.slice(0, 4), 'p')!.index).toBe(0);
  });

  it('gives a turn the user spoke into one footer, timed from its start to its end, with all its text', () => {
    const messages = [you('one', { sentAt: 1_000, turnEndedAt: 9_000 }), agent('a'), you('also', { sentAt: 4_000, midTurn: 'read' }), agent('b')];
    expect(turnFooters(messages, false)).toEqual([{ at: 3, timing: { startedAt: 1_000, endedAt: 9_000 }, markdown: 'a\n\nb', fork: { turn: 'u-one', latest: true, point: false } }]);
  });

  it('counts messages sent together (a flushed queue) as one turn', () => {
    expect(turnSpans([you('one'), you('two'), agent('a')])).toEqual([{ start: 0, replies: 2, end: 2 }]);
  });

  it('starts a new turn after one that was stopped before the agent said anything', () => {
    const messages = [you('one', { sentAt: 1_000, turnEndedAt: 3_000 }), you('two', { sentAt: 4_000 }), agent('b')];
    expect(turnSpans(messages)).toEqual([
      { start: 0, replies: 1, end: 0 },
      { start: 1, replies: 2, end: 2 },
    ]);
    // The new turn shows no footer while it runs; the stopped one, unanswered, shows none either.
    expect(turnFooters(messages, true)).toEqual([]);
  });

  it('starts a turn at a notice that woke the agent, but not at other notices', () => {
    const messages = [you('one'), agent('a'), agent('news', { notice: 'info', sentAt: 5 }), agent('b'), agent('oops', { notice: 'error' })];
    expect(turnSpans(messages)).toEqual([
      { start: 0, replies: 1, end: 1 },
      { start: 2, replies: 3, end: 4 },
    ]);
  });
});

describe('the footer of a finished turn', () => {
  it('sits under the turn\'s last message with its timing and the agent\'s text joined by blank lines', () => {
    const messages = [you('go', { sentAt: 1_000, turnEndedAt: 135_000 }), agent('First part.'), steps('s'), agent('Second **part**.')];
    expect(turnFooters(messages, false)).toEqual([{ at: 3, timing: { startedAt: 1_000, endedAt: 135_000 }, markdown: 'First part.\n\nSecond **part**.', fork: { turn: 'u-go', latest: true, point: false } }]);
  });

  it('leaves out tool steps, cards, notices, suggestions and the user\'s message', () => {
    const messages = [
      you('go', { sentAt: 0, turnEndedAt: 10 }),
      steps('s'),
      agent('', { todos: [{ text: 't', status: 'completed' }] }),
      agent('Failed to read', { notice: 'error' }),
      agent('', { suggestion: { id: 'x', kind: 'note', title: 't' } as unknown as ChatMessage['suggestion'] }),
      agent('Done.'),
    ];
    expect(turnFooters(messages, false)[0]!.markdown).toBe('Done.');
  });

  it('shows no footer while the agent works on the turn', () => {
    const messages = [you('go', { sentAt: 0 }), agent('Working on it')];
    expect(turnFooters(messages, true)).toEqual([]);
  });

  it('shows no footer while text streams or a card waits for the user, even on an idle session', () => {
    const card = { id: 'r', kind: 'approval' as const, title: 'Run', detail: 'ls', tool: 'Bash', options: [] };
    expect(turnFooters([you('go'), agent('Asking', {}), agent('', { input: card })], false)).toEqual([]);
    expect(turnFooters([you('go'), agent('Half', { streaming: true })], false)).toEqual([]);
    // Answered: the card no longer holds the turn open.
    expect(turnFooters([you('go'), agent('', { input: { ...card, resolved: 'Allow' } }), agent('Ran it.')], false)).toHaveLength(1);
  });

  it('keeps earlier turns finished while a later one runs', () => {
    const messages = [you('one', { sentAt: 0, turnEndedAt: 5_000 }), agent('a'), you('two', { sentAt: 6_000 }), agent('b')];
    expect(turnFooters(messages, true).map((f) => f.at)).toEqual([1]);
  });

  it('gives a turn stored before turns were timed no timing, never a made-up one, but still its text', () => {
    const messages = [you('one'), agent('Old answer.')];
    expect(turnFooters(messages, false)).toMatchObject([{ at: 1, markdown: 'Old answer.' }]);
  });

  it('times a turn started by several messages from the first to the end', () => {
    const messages = [you('one', { sentAt: 1_000 }), you('two', { sentAt: 1_000, turnEndedAt: 9_000 }), agent('a')];
    expect(turnFooters(messages, false)[0]!.timing).toEqual({ startedAt: 1_000, endedAt: 9_000 });
  });

  it('has no footer for a turn with neither text nor timing, and none before the agent replied', () => {
    expect(turnFooters([you('one'), steps('s')], false)).toEqual([]);
    expect(turnFooters([you('one', { sentAt: 0, turnEndedAt: 1 })], false)).toEqual([]);
  });

  it('times a turn where the agent only used tools, with nothing to copy', () => {
    expect(turnFooters([you('one', { sentAt: 0, turnEndedAt: 2_000 }), steps('s')], false)).toMatchObject([{ at: 1, timing: { startedAt: 0, endedAt: 2_000 }, markdown: '' }]);
  });
});

describe('stamping the end of a turn', () => {
  it('stamps the latest message that started a turn, once', () => {
    const messages = [you('one', { sentAt: 0 }), agent('a')];
    const stamped = endTurn(messages, 7_000)!;
    expect(stamped.index).toBe(0);
    expect(stamped.message.turnEndedAt).toBe(7_000);
    expect(messages[0]!.turnEndedAt).toBeUndefined(); // copied, never changed in place
    expect(endTurn([{ ...messages[0]!, turnEndedAt: 7_000 }, messages[1]!], 8_000)).toBeNull();
  });

  it('stamps nothing when no turn was started', () => {
    expect(endTurn([agent('hello')], 1)).toBeNull();
  });
});

describe('how long a turn took', () => {
  it('reads as seconds, minutes and seconds, or hours and minutes', () => {
    expect(durationText(300)).toBe('<1s');
    expect(durationText(48_000)).toBe('48s');
    expect(durationText(134_000)).toBe('2m 14s');
    expect(durationText(125_000)).toBe('2m 05s');
    expect(durationText(3_780_000)).toBe('1h 03m');
  });
});

describe('where a turn ends in the agent’s conversation (Fork)', () => {
  it('is stamped on the message that started the turn under way, once', () => {
    const messages = [you('one', { forkPoint: 'p1' }), agent('a'), you('two'), agent('b')];
    const marked = markForkPoint(messages, 'p2')!;
    expect(marked).toEqual({ index: 2, message: { ...messages[2]!, forkPoint: 'p2' } });
    expect(markForkPoint([...messages.slice(0, 2)], 'p1')).toBeNull();
    expect(markForkPoint([agent('before any turn')], 'p')).toBeNull();
  });

  it('gives every footer its turn: the last is the end; an earlier one can be forked from only with its point', () => {
    const messages = [you('one', { forkPoint: 'p1' }), agent('a'), you('two'), agent('b'), you('three', { forkPoint: 'p3' }), agent('c')];
    expect(turnFooters(messages, false).map((f) => f.fork)).toEqual([
      { turn: 'u-one', latest: false, point: true },
      { turn: 'u-two', latest: false, point: false },
      { turn: 'u-three', latest: true, point: true },
    ]);
  });

  it('a queued pair of messages is one turn: its point is on the last starter, its id the first', () => {
    const messages = [you('a'), you('b', { forkPoint: 'p' }), agent('x'), you('c'), agent('y')];
    expect(turnFooters(messages, false)[0]!.fork).toEqual({ turn: 'u-a', latest: false, point: true });
  });
});
