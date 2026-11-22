// One page of a conversation (shared/transcript-page.ts): its end, or the messages before one.
import { describe, expect, it } from 'vitest';
import { messageKey, pageRefusal, transcriptPage } from './transcript-page.ts';

const conversation = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, text: `${i}` }));
const ids = (page: { messages: { id?: string }[] }) => page.messages.map((m) => m.id);

describe('a page of a conversation', () => {
  it('gives the last N, and where to ask for the page before', () => {
    expect(transcriptPage(conversation(10), { last: 3 })).toEqual({ messages: conversation(10).slice(7), before: 'm7', total: 10 });
  });

  it('gives the N before a message, ending just before it', () => {
    const page = transcriptPage(conversation(10), { before: 'm7', limit: 3 });
    expect(ids(page)).toEqual(['m4', 'm5', 'm6']);
    expect(page.before).toBe('m4');
  });

  it('walks back to the start, where there is nothing before', () => {
    const messages = conversation(7);
    const seen: string[] = [];
    let page = transcriptPage(messages, { last: 3 });
    for (;;) {
      seen.unshift(...(ids(page) as string[]));
      if (page.before === null) break;
      page = transcriptPage(messages, { before: page.before, limit: 3 });
    }
    expect(seen).toEqual(ids({ messages }));
  });

  it('gives a short conversation whole, and an empty one empty', () => {
    expect(transcriptPage(conversation(2), { last: 50 })).toEqual({ messages: conversation(2), before: null, total: 2 });
    expect(transcriptPage([], { last: 50 })).toEqual({ messages: [], before: null, total: 0 });
  });

  it('gives nothing before the first message', () => {
    expect(transcriptPage(conversation(3), { before: 'm0', limit: 5 })).toEqual({ messages: [], before: null, total: 3 });
  });

  it('refuses a message no longer there, and gives an empty page for it', () => {
    expect(pageRefusal(conversation(3), { before: 'gone', limit: 5 })).toMatch(/no longer in the conversation/);
    expect(pageRefusal(conversation(3), { before: 'm1', limit: 5 })).toBeNull();
    expect(pageRefusal([], { last: 5 })).toBeNull();
    expect(transcriptPage(conversation(3), { before: 'gone', limit: 5 }).messages).toEqual([]);
  });

  it('keys a stored message with no id by its place, so it can be paged from', () => {
    const messages = [{ text: 'a' }, { text: 'b' }, { id: 'm2', text: 'c' }];
    expect(messageKey(messages[1]!, 1)).toBe('stored-1');
    const page = transcriptPage(messages, { last: 2 });
    expect(page.messages).toEqual([{ id: 'stored-1', text: 'b' }, { id: 'm2', text: 'c' }]);
    expect(page.before).toBe('stored-1');
    expect(ids(transcriptPage(messages, { before: 'stored-1', limit: 1 }))).toEqual(['stored-0']);
    expect(messages[1]).toEqual({ text: 'b' });
  });
});
