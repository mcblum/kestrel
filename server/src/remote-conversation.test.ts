// A remote conversation as the route answers it (remote-conversation.ts): the account's copy at once, whatever the
// other computer does; that computer asked in the background only when the copy is behind or the session may be
// ahead of it, its answer laid over the copy and sent on the live channel; "did not answer" only when the copy is
// behind and it really did not.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionView } from './model.ts';
import { newerPart, overKept, RemoteConversations, type Kept, type ReadRemote } from './remote-conversation.ts';
import type { RemoteRead } from './connect/link/remote-sessions.ts';
import { transcriptPage, type PageAsk } from './shared/transcript-page.ts';

const MINI = { id: 'mini-1', name: 'Mac mini' };
const done = { id: 's1', runsOn: MINI.id, state: 'done' } as SessionView;
const running = { ...done, state: 'running' } as SessionView;
const conversation = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, author: i % 2 ? 'agent' : 'you', time: '', text: `message ${i}` }));
const texts = (messages: readonly ChatMessage[]) => messages.map((m) => m.text);

/** A machine holding `messages`, counting what it is asked; `hold` keeps every answer back until released. */
function machine(messages: ChatMessage[], hold = false) {
  const asked: (PageAsk & { fresh?: boolean })[] = [];
  let release = () => {};
  const gate = hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const read: ReadRemote = async (_machine, _id, page, opts) => {
    asked.push({ ...page, ...(opts?.fresh ? { fresh: true } : {}) });
    await gate;
    const found = transcriptPage(messages, page);
    return { ok: true, page: { messages: found.messages, before: found.before, total: found.total } };
  };
  return { read, asked, release: () => release() };
}

const away: ReadRemote = async (): Promise<RemoteRead> => ({ ok: false, reached: false, reason: 'did not answer' });

function remote(read: ReadRemote | null, kept: Kept) {
  const published: ChatMessage[][] = [];
  const r = new RemoteConversations({ read, kept: async () => kept, publish: (_id, messages) => published.push(messages) });
  return { r, published };
}

const body = (answer: Awaited<ReturnType<RemoteConversations['detail']>>) => {
  if (answer.status !== 200) throw new Error(answer.body.error);
  return answer.body;
};

describe('overKept and newerPart', () => {
  it('lays the newer messages over the kept ones from where they meet, and says when they do not', () => {
    const all = conversation(6);
    expect(overKept(all.slice(0, 4), all.slice(2))).toEqual(all);
    const changed = { ...all[3]!, text: 'finished' };
    expect(texts(overKept(all.slice(0, 4), [changed, ...all.slice(4)])!)).toEqual(['message 0', 'message 1', 'message 2', 'finished', 'message 4', 'message 5']);
    expect(overKept(all.slice(0, 2), all.slice(4))).toBeNull();
  });

  it('the newer part starts at the last message the two share, so it always meets the copy', () => {
    const all = conversation(6);
    expect(newerPart(all.slice(0, 4), all)).toEqual(all.slice(3));
    expect(overKept(all.slice(0, 4), newerPart(all.slice(0, 4), all))).toEqual(all);
    expect(newerPart([], all)).toEqual(all);
  });
});

describe('RemoteConversations', () => {
  it('a finished session with a whole copy opens from it and its machine is never asked', async () => {
    const all = conversation(400);
    const m = machine(all);
    const { r, published } = remote(m.read, { messages: all, current: true, readAt: 1000, stamp: 'a' });
    const answer = body(await r.detail(done, MINI, null));
    expect(answer.messages).toEqual(all);
    expect(answer.remote).toEqual({ machine: MINI, current: true, reachable: true, asOf: 1000 });
    await r.settled();
    expect(m.asked).toEqual([]);
    expect(published).toEqual([]);
  });

  it('answers with the model and mode its head says, whatever its machine does (issue 79)', async () => {
    const settings = { model: 'gpt-5', permission: 'auto' as const };
    const { r } = remote(away, { messages: conversation(2), current: true, readAt: 1000, stamp: 'a', settings });
    expect(body(await r.detail(done, MINI, null)).settings).toEqual(settings);
    expect(body(await r.detail(done, MINI, { last: 1 })).settings).toEqual(settings);
    // An older machine's head says none: none is made up.
    const { r: older } = remote(away, { messages: conversation(2), current: true, readAt: 1000, stamp: 'a' });
    expect(body(await older.detail(done, MINI, null))).not.toHaveProperty('settings');
  });

  it('a copy that is behind opens at once, and what its machine answers later is laid over it', async () => {
    const all = conversation(10);
    const m = machine(all, true);
    const { r, published } = remote(m.read, { messages: all.slice(0, 8), current: false, readAt: 1000, stamp: 'a' });
    // The machine has not answered: the copy is answered now, not "did not answer".
    const first = body(await r.detail(done, MINI, null));
    expect(texts(first.messages)).toEqual(texts(all.slice(0, 8)));
    expect(first.remote).toEqual({ machine: MINI, current: false, reachable: true, asOf: 1000 });
    // Asked once however often it is opened meanwhile.
    await r.detail(done, MINI, null);
    m.release();
    await r.settled();
    expect(m.asked).toEqual([{ last: 50 }]);
    expect(published).toEqual([all.slice(7)]);
    // While the head says the same, the next read has it too.
    const after = body(await r.detail(done, MINI, null));
    expect(after.messages).toEqual(all);
    expect(after.remote?.current).toBe(true);
  });

  it('reads back page by page until it meets a copy that is far behind', async () => {
    const all = conversation(450);
    const m = machine(all);
    const { r } = remote(m.read, { messages: all.slice(0, 30), current: false, readAt: null, stamp: 'a' });
    await r.detail(done, MINI, null);
    await r.settled();
    expect(body(await r.detail(done, MINI, null)).messages).toEqual(all);
    expect(m.asked).toEqual([{ last: 50 }, { before: 'm400', limit: 200 }, { before: 'm200', limit: 200 }]);
  });

  it('says its machine did not answer only once it was asked and did not, and Try again asks afresh', async () => {
    const all = conversation(4);
    const asked: { fresh?: boolean }[] = [];
    const read: ReadRemote = async (machine, id, page, opts) => (asked.push({ ...(opts?.fresh ? { fresh: true } : {}) }), away(machine, id, page, opts));
    const { r } = remote(read, { messages: all.slice(0, 2), current: false, readAt: 1234, stamp: 'a' });
    expect(body(await r.detail(done, MINI, null)).remote?.reachable).toBe(true);
    await r.settled();
    const after = body(await r.detail(done, MINI, null));
    expect(after.remote).toEqual({ machine: MINI, current: false, reachable: false, asOf: 1234 });
    expect(texts(after.messages)).toEqual(['message 0', 'message 1']);
    await r.settled();
    await r.detail(done, MINI, null, true);
    await r.settled();
    expect(asked.at(-1)).toEqual({ fresh: true });
  });

  it('a session running there is asked for its newest part even when the copy matches its head', async () => {
    const all = conversation(6);
    const m = machine(all);
    const { r, published } = remote(m.read, { messages: all.slice(0, 5), current: true, readAt: 1, stamp: 'a' });
    expect(body(await r.detail(running, MINI, null)).remote?.current).toBe(true);
    await r.settled();
    expect(m.asked).toEqual([{ last: 50 }]);
    expect(published).toEqual([all.slice(4)]);
  });

  it('with no account to ask through, a copy that is behind says its machine did not answer, at once', async () => {
    const all = conversation(4);
    const { r } = remote(null, { messages: all, current: false, readAt: null });
    expect(body(await r.detail(done, MINI, null)).remote).toEqual({ machine: MINI, current: false, reachable: false, asOf: null });
  });

  it('a refusal there is an answer: not "did not answer", and nothing is laid over the copy', async () => {
    const all = conversation(4);
    const refuses: ReadRemote = async () => ({ ok: false, reached: true, reason: 'That session is no longer in Kestrel.' });
    const { r } = remote(refuses, { messages: all, current: false, readAt: 1, stamp: 'a' });
    await r.detail(done, MINI, null);
    await r.settled();
    expect(body(await r.detail(done, MINI, null)).remote).toMatchObject({ current: false, reachable: true });
  });

  it('a page comes from the copy, and from its machine only when the copy does not have where it starts', async () => {
    const all = conversation(10);
    const m = machine(all);
    const { r } = remote(m.read, { messages: all.slice(0, 6), current: false, readAt: null, stamp: 'a' });
    const kept = body(await r.detail(done, MINI, { before: 'm4', limit: 2 }));
    expect(kept.messages.map((x) => x.id)).toEqual(['m2', 'm3']);
    expect(kept.page).toEqual({ before: 'm2', total: 6 });
    expect(m.asked).toEqual([]);
    const there = body(await r.detail(done, MINI, { before: 'm8', limit: 2 }));
    expect(there.messages.map((x) => x.id)).toEqual(['m6', 'm7']);
    expect(m.asked).toEqual([{ before: 'm8', limit: 2 }]);
    const { r: none } = remote(away, { messages: all.slice(0, 6), current: false, readAt: null });
    expect((await none.detail(done, MINI, { before: 'gone', limit: 2 })).status).toBe(404);
  });
});
