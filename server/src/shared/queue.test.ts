import { describe, expect, it } from 'vitest';
import { afterTurn, EMPTY_QUEUE, enqueue, removeQueued, shouldFlush, takeAll, type SessionQueue } from './queue.ts';

const two = (): SessionQueue => enqueue(enqueue(EMPTY_QUEUE, { id: 'a', text: 'first' }), { id: 'b', text: ' second\n' });

describe('the message queue', () => {
  it('keeps messages in the order written, trimmed, and ignores empty ones', () => {
    const q = enqueue(two(), { id: 'c', text: '   ' });
    expect(q.items.map((m) => [m.id, m.text])).toEqual([
      ['a', 'first'],
      ['b', 'second'],
    ]);
  });

  it('does not change the queue it was given', () => {
    const before = two();
    const snapshot = JSON.stringify(before);
    enqueue(before, { id: 'x', text: 'x' });
    removeQueued(before, 'a');
    afterTurn(before, 'stopped');
    takeAll(before, { text: 'now' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('removes one message by id, and is unchanged for an unknown id', () => {
    const q = two();
    expect(removeQueued(q, 'a').items.map((m) => m.id)).toEqual(['b']);
    expect(removeQueued(q, 'nope')).toBe(q);
  });

  it('flushes after a normal end, and holds after a stop or a failure', () => {
    const q = two();
    expect(shouldFlush(q, 'complete')).toBe(true);
    for (const end of ['stopped', 'failed'] as const) {
      expect(shouldFlush(q, end)).toBe(false);
      const held = afterTurn(q, end);
      expect(held.held).toBe(true);
      // A held queue stays put even after a later normal turn (a summary the user asked for).
      expect(shouldFlush(afterTurn(held, 'complete'), 'complete')).toBe(false);
    }
    expect(shouldFlush(EMPTY_QUEUE, 'complete')).toBe(false);
    expect(afterTurn(EMPTY_QUEUE, 'stopped')).toBe(EMPTY_QUEUE);
  });

  it('is re-armed when the user queues again, and forgets the hold once empty', () => {
    const held = afterTurn(two(), 'stopped');
    expect(enqueue(held, { id: 'c', text: 'more' }).held).toBe(false);
    expect(removeQueued(removeQueued(held, 'a'), 'b')).toEqual(EMPTY_QUEUE);
  });

  it('sends everything as one turn joined by a blank line, the message typed now last', () => {
    const { text, queue } = takeAll(two(), { text: 'third' });
    expect(text).toBe('first\n\nsecond\n\nthird');
    expect(queue).toEqual(EMPTY_QUEUE);
    expect(takeAll(two()).text).toBe('first\n\nsecond');
  });

  it('says whether the user wrote any of the turn, or all of it came from other sessions', () => {
    const asked = enqueue(EMPTY_QUEUE, { id: 'k', text: 'from a session', fromAgent: true });
    expect(asked.items[0]!.fromAgent).toBe(true);
    expect(takeAll(asked).byUser).toBe(false);
    expect(takeAll(EMPTY_QUEUE, { text: 'asked', fromAgent: true }).byUser).toBe(false);
    expect(takeAll(asked, { text: 'typed' }).byUser).toBe(true);
    expect(takeAll(two()).byUser).toBe(true);
  });

  it('merges settings changes in order, later ones winning, and drops empty ones', () => {
    let q = enqueue(EMPTY_QUEUE, { id: 'a', text: 'a', change: { model: 'opus', permission: 'plan' } });
    q = enqueue(q, { id: 'b', text: 'b', change: { permission: 'edits', model: undefined } });
    q = enqueue(q, { id: 'c', text: 'c', change: {} });
    expect(q.items[2]).toEqual({ id: 'c', text: 'c' });
    expect(takeAll(q).change).toEqual({ model: 'opus', permission: 'edits' });
    expect(takeAll(q, { text: 'd', change: { model: '' } }).change).toEqual({ model: '', permission: 'edits' });
  });
});

describe('queued messages with files', () => {
  const file = { id: 'f1', name: 'a.png', mediaType: 'image/png', size: 3, kind: 'image' as const };
  it('queues a message of files alone, and carries the files into the turn in order', () => {
    const q = enqueue(enqueue(EMPTY_QUEUE, { id: '1', text: '', attachments: [file] }), { id: '2', text: 'and this' });
    expect(q.items).toHaveLength(2);
    const all = takeAll(q, { text: 'now', attachments: [{ ...file, id: 'f2' }] });
    expect(all.text).toBe('and this\n\nnow');
    expect(all.attachments.map((a) => a.id)).toEqual(['f1', 'f2']);
    expect(all.parts).toEqual([{ text: '', attachments: [file] }, { text: 'and this' }, { text: 'now', attachments: [{ ...file, id: 'f2' }] }]);
  });
  it('still drops a message with neither text nor files', () => {
    expect(enqueue(EMPTY_QUEUE, { id: '1', text: '  ', attachments: [] })).toBe(EMPTY_QUEUE);
  });
});

describe('effort and fast mode in a queued change', () => {
  it('go with the turn that carries them, later changes winning', () => {
    let q = enqueue(EMPTY_QUEUE, { id: 'a', text: 'one', change: { effort: 'high', fast: true } });
    q = enqueue(q, { id: 'b', text: 'two', change: { effort: 'low' } });
    expect(takeAll(q).change).toEqual({ effort: 'low', fast: true });
  });
});
