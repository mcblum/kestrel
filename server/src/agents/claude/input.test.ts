// The open input of a Claude query: messages read in push order, waiting while there are none, ending on close.
import { describe, expect, it } from 'vitest';
import { InputChannel } from './input.ts';

async function readAll<T>(channel: InputChannel<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of channel) out.push(item);
  return out;
}

describe('the input channel', () => {
  it('gives messages in the order pushed, a slow one included, and ends once closed', async () => {
    const channel = new InputChannel<string>();
    let release!: (v: string) => void;
    channel.push(new Promise<string>((resolve) => (release = resolve)));
    channel.push('second');
    const all = readAll(channel);
    release('first');
    channel.close();
    expect(await all).toEqual(['first', 'second']);
  });

  it('waits while empty and goes on when a message arrives later', async () => {
    const channel = new InputChannel<number>();
    const reader = channel[Symbol.asyncIterator]();
    const pending = reader.next();
    channel.push(1);
    expect(await pending).toEqual({ value: 1, done: false });
    const end = reader.next();
    channel.close();
    expect(await end).toEqual({ value: undefined, done: true });
  });

  it('ignores a push after close', async () => {
    const channel = new InputChannel<number>();
    channel.close();
    channel.push(1);
    expect(channel.isClosed).toBe(true);
    expect(await readAll(channel)).toEqual([]);
  });
});
