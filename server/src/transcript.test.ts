import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './model.ts';
import { applyToTranscript, liveStatus, UNANSWERED_LABEL, type TranscriptAction } from './transcript.ts';

describe('the live status line', () => {
  it('passes the agent\'s own status through and names a running tool', () => {
    expect(liveStatus({ type: 'status', text: 'Thinking…' })).toBe('Thinking…');
    expect(liveStatus({ type: 'tool', id: 't', name: 'Bash', summary: 'Run pnpm test', status: 'started' })).toBe('Run pnpm test…');
    expect(liveStatus({ type: 'tool', id: 't', name: 'Bash', summary: 'Run pnpm test', status: 'finished' })).toBe('Thinking…');
  });
  it('clears when the turn ends or the agent waits for the user', () => {
    expect(liveStatus({ type: 'done', reason: 'complete' })).toBe('');
    expect(liveStatus({ type: 'failed', reason: 'x', kind: 'other' })).toBe('');
  });
  it('says nothing for text and file changes', () => {
    expect(liveStatus({ type: 'message', id: 'm', text: 'a', delta: 'a', done: false })).toBeUndefined();
    expect(liveStatus({ type: 'files-changed', paths: [] })).toBeUndefined();
  });
});

/** Apply actions in order, as the runtime does. */
const run = (actions: TranscriptAction[], from: ChatMessage[] = []) => actions.reduce<ChatMessage[]>((messages, a) => applyToTranscript(messages, a, '10:00').messages, from);
const todo = (text: string, status: 'pending' | 'in_progress' | 'completed') => ({ text, status });

describe('a message sent into the running turn', () => {
  it('shows as the user\'s, marked sent, and is marked read once the agent says so', () => {
    const messages = run([
      { type: 'user', id: 'u1', text: 'go' },
      { type: 'user', id: 'u2', text: 'also this', midTurn: true },
      { type: 'user', id: 'u3', text: 'and this', midTurn: true },
    ]);
    expect(messages.map((m) => [m.id, m.author, m.midTurn])).toEqual([
      ['u1', 'you', undefined],
      ['u2', 'you', 'sent'],
      ['u3', 'you', 'sent'],
    ]);
    const read = applyToTranscript(messages, { type: 'picked-up', ids: ['u2'] }, '10:01');
    expect(read.changed.map((m) => [m.id, m.midTurn])).toEqual([['u2', 'read']]);
    expect(read.messages[2]!.midTurn).toBe('sent');
    // Read already, or not a mid-turn message: nothing changes.
    expect(applyToTranscript(read.messages, { type: 'picked-up', ids: ['u2', 'u1'] }, '10:02').changed).toEqual([]);
  });

  it('is taken back out when withdrawn, and nothing else moves', () => {
    const messages = run([
      { type: 'user', id: 'u1', text: 'go' },
      { type: 'user', id: 'u2', text: 'unread', midTurn: true },
      { type: 'message', id: 'a1', text: 'ok', delta: 'ok', done: true },
    ]);
    expect(applyToTranscript(messages, { type: 'withdrawn', ids: ['u2'] }, '10:01').messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });
});

describe('the task list in the conversation', () => {
  it('is changed in place while the user has said nothing since', () => {
    const before = run([{ type: 'user', id: 'u1', text: 'go' }, { type: 'todos', items: [todo('a', 'in_progress'), todo('b', 'pending')] }, { type: 'message', id: 'm1', text: 'working', delta: 'working', done: true }]);
    const { messages, changed } = applyToTranscript(before, { type: 'todos', items: [todo('a', 'completed'), todo('b', 'in_progress')] }, '10:01');
    expect(messages.filter((m) => m.todos)).toHaveLength(1);
    expect(messages[1]!.todos).toEqual([todo('a', 'completed'), todo('b', 'in_progress')]);
    expect(changed).toEqual([messages[1]]);
    // The list changed by copying, never in place.
    expect(before[1]!.todos).toEqual([todo('a', 'in_progress'), todo('b', 'pending')]);
  });

  it('moves to a new message after the user writes, carrying unfinished tasks', () => {
    const messages = run([
      { type: 'user', id: 'u1', text: 'go' },
      { type: 'task', id: '1', text: 'first', status: 'completed' },
      { type: 'task', id: '2', text: 'second', status: 'pending' },
      { type: 'user', id: 'u2', text: 'more' },
      { type: 'task', id: '2', status: 'in_progress' },
    ]);
    const lists = messages.filter((m) => m.todos);
    expect(lists).toHaveLength(2);
    expect(messages.at(-1)!.todos).toEqual([{ id: '1', text: 'first', status: 'completed' }, { id: '2', text: 'second', status: 'in_progress' }]);
    expect(lists[0]!.todos!.map((t) => t.status)).toEqual(['completed', 'pending']);
  });

  it('drops a fully completed list when it moves, and removes a deleted task', () => {
    const messages = run([
      { type: 'user', id: 'u1', text: 'go' },
      { type: 'task', id: '1', text: 'done one', status: 'completed' },
      { type: 'user', id: 'u2', text: 'next' },
      { type: 'task', id: '5', text: 'new', status: 'pending' },
      { type: 'task', id: '6', text: 'gone', status: 'pending' },
      { type: 'task', id: '6', status: 'deleted' },
    ]);
    expect(messages.at(-1)!.todos).toEqual([{ id: '5', text: 'new', status: 'pending' }]);
  });

  it('does not collect tool lines', () => {
    const messages = run([{ type: 'todos', items: [todo('a', 'pending')] }, { type: 'tool', id: 't', name: 'Bash', summary: 'Run ls', status: 'started' }]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.activity).toBeUndefined();
  });
});

describe('cards', () => {
  it('adds a widget, file or next step as its own message, and replaces one sent again with the same id', () => {
    const messages = run([
      { type: 'card', id: 'w', widget: { title: 'Chart', code: '<svg/>' } },
      { type: 'card', id: 'images-t1', images: ['t1-0.png'] },
      { type: 'card', id: 'images-t1', images: ['t1-0.png', 't1-1.png'] },
    ]);
    expect(messages.map((m) => m.id)).toEqual(['w', 'images-t1']);
    expect(messages[0]).toMatchObject({ author: 'agent', text: '', widget: { title: 'Chart', code: '<svg/>' } });
    expect(messages[1]!.images).toEqual(['t1-0.png', 't1-1.png']);
  });

  it('keeps when a picture card first appeared when more pictures join it', () => {
    const messages = run([
      { type: 'card', id: 'images-t1', images: ['t1-0.png'], at: 1000 },
      { type: 'card', id: 'images-t1', images: ['t1-0.png', 't1-1.png'], at: 2000 },
      { type: 'card', id: 'w', widget: { title: 'Chart', code: '<svg/>' } },
    ]);
    expect(messages[0]!.at).toBe(1000);
    expect(messages[1]!.at).toBeUndefined();
  });

  it('marks a card nobody answered once the turn ends, and leaves an answered one as it was', () => {
    const card = (id: string) => ({ type: 'needs-input' as const, request: { id, kind: 'approval' as const, title: 'Run a command', detail: 'ls', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' as const }] } });
    const before = run([card('a'), { type: 'resolved', requestId: 'a', label: 'Allow' }, card('b')]);
    const { messages, changed } = applyToTranscript(before, { type: 'done', reason: 'stopped' }, '10:03');
    expect(messages.map((m) => m.input!.resolved)).toEqual(['Allow', UNANSWERED_LABEL]);
    expect(changed.map((m) => m.id)).toEqual(['input-b']);
    expect(before[1]!.input!.resolved).toBeUndefined();
  });

  it('keeps a refusal or warning on a step once said, through later events about the same call', () => {
    const steps = run([
      { type: 'tool', id: 'p1', name: 'Write', summary: 'Write README.md', status: 'failed', detail: 'no', refusal: 'In "Beta"; use delegate.' },
      { type: 'tool', id: 'p1', name: 'Write', summary: 'Write README.md', status: 'failed', detail: 'The change was declined.' },
      { type: 'tool', id: 'p2', name: 'Write', summary: 'Write x', status: 'finished', detail: 'note', warning: 'Could not refuse it.' },
      { type: 'tool', id: 'p2', name: 'Write', summary: 'Write x', status: 'finished', detail: '' },
      { type: 'tool', id: 'p3', name: 'Bash', summary: 'Run false', status: 'failed', detail: 'Exit 1' },
    ]).flatMap((m) => m.activity ?? []);
    expect(steps.map((a) => [a.refusal, a.warning])).toEqual([['In "Beta"; use delegate.', undefined], [undefined, 'Could not refuse it.'], [undefined, undefined]]);
  });

  it('ends a step still running as stopped when the user stopped the turn, and as done when it ended otherwise', () => {
    const running = run([{ type: 'tool', id: 'a', name: 'Bash', summary: 'Run ls', status: 'started' }, { type: 'tool', id: 'a', name: 'Bash', summary: 'Run ls', status: 'finished' }, { type: 'tool', id: 'b', name: 'Bash', summary: 'Run sleep 90', status: 'started' }]);
    const stopped = applyToTranscript(running, { type: 'done', reason: 'stopped' }, '10:03').messages;
    expect(stopped.flatMap((m) => m.activity ?? []).map((a) => a.status)).toEqual(['done', 'stopped']);
    const complete = applyToTranscript(running, { type: 'done', reason: 'complete' }, '10:03').messages;
    expect(complete.flatMap((m) => m.activity ?? []).map((a) => a.status)).toEqual(['done', 'done']);
  });

  it('spends the reply buttons of earlier next steps once the user writes', () => {
    const before = run([{ type: 'card', id: 'n', next: { recap: 'Done.', ask: 'Ship?', replies: ['Yes', 'Not yet'] } }]);
    const { messages, changed } = applyToTranscript(before, { type: 'user', id: 'u', text: 'Yes' }, '10:02');
    expect(messages[0]!.next).toEqual({ recap: 'Done.', ask: 'Ship?', replies: ['Yes', 'Not yet'], done: true });
    expect(before[0]!.next!.done).toBeUndefined();
    expect(changed.map((m) => m.id)).toEqual(['n', 'u']);
  });
});

describe('timing a turn', () => {
  const step = (messages: ChatMessage[], action: TranscriptAction, now?: number) => applyToTranscript(messages, action, '10:00', now);

  it('stamps when the user\'s message was sent and when the turn ended, on that message', () => {
    let messages = step([], { type: 'user', id: 'u1', text: 'go' }, 1_000).messages;
    messages = step(messages, { type: 'message', id: 'm1', text: 'ok', delta: 'ok', done: true }, 2_000).messages;
    const ended = step(messages, { type: 'done', reason: 'complete' }, 9_000);
    expect(ended.messages[0]).toMatchObject({ sentAt: 1_000, turnEndedAt: 9_000 });
    expect(ended.changed.map((m) => m.id)).toContain('u1');
  });

  it('ends a failed or stopped turn too, but not one a restart cut off', () => {
    const start = step([], { type: 'user', id: 'u1', text: 'go' }, 1_000).messages;
    expect(step(start, { type: 'failed', reason: 'x', kind: 'other' }, 3_000).messages[0]!.turnEndedAt).toBe(3_000);
    expect(step(start, { type: 'done', reason: 'stopped' }, 4_000).messages[0]!.turnEndedAt).toBe(4_000);
    expect(step(start, { type: 'settled' }, 5_000).messages[0]!.turnEndedAt).toBeUndefined();
  });

  it('marks a notice that woke the agent as the start of a turn, and no other notice', () => {
    const woke = step([], { type: 'notice', id: 'n1', text: 'news', level: 'info', startsTurn: true }, 1_000).messages[0]!;
    const plain = step([], { type: 'notice', id: 'n2', text: 'refused', level: 'error' }, 1_000).messages[0]!;
    expect(woke.sentAt).toBe(1_000);
    expect(plain.sentAt).toBeUndefined();
  });

  it('stamps nothing without a clock', () => {
    const messages = step([], { type: 'user', id: 'u1', text: 'go' }).messages;
    expect(messages[0]!.sentAt).toBeUndefined();
    expect(step(messages, { type: 'done', reason: 'complete' }).messages[0]!.turnEndedAt).toBeUndefined();
  });
});

describe('where a turn ends in the agent’s conversation', () => {
  it('is kept on the message that started the turn, and sent as a change; the same point again changes nothing', () => {
    const started = applyToTranscript([], { type: 'user', id: 'u1', text: 'Go' }, '10:00', 1000).messages;
    const marked = applyToTranscript(started, { type: 'turn-point', point: 'p1' }, '10:00', 2000);
    expect(marked.messages[0]).toMatchObject({ id: 'u1', forkPoint: 'p1' });
    expect(marked.changed).toEqual([marked.messages[0]]);
    expect(applyToTranscript(marked.messages, { type: 'turn-point', point: 'p1' }, '10:00', 3000).changed).toEqual([]);
  });
});
