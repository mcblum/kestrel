// Opening a session that runs on another computer (account-sessions.md, sections 9.2 and 19): two desks of one
// account on the fake service and its relay, each with the real Connect module, the Mac mini with a real runtime and
// a fake agent, the laptop serving its window over HTTP and WebSocket. The rule (Matt, 2026-11-25): the laptop reads
// the Mac mini's sessions from the service into its replica, in the background, and opens them from there at once;
// the Mac mini itself is asked only for what only it has: live output while a turn runs, and what the account's copy
// lacks for a moment after a turn (the upload lags its head).
import { afterEach, describe, expect, it } from 'vitest';
import { SELECTABLE_AGENTS, type ChatMessage } from '../../model.ts';
import { until } from '../../test-agent.ts';
import { account, closeDesks, laptopWindow, remoteSession } from './two-desks.ts';

afterEach(closeDesks);

const texts = (messages: { text: string }[]) => messages.map((m) => m.text);
const liveTexts = (w: Awaited<ReturnType<typeof laptopWindow>>, id: string) => w.live.filter((l) => l.sessionId === id).flatMap((l) => texts((l.patch.messages ?? []) as ChatMessage[]));

describe.each(SELECTABLE_AGENTS)('a %s session that runs on another computer', (agent) => {
  it('is read from the account in the background and opens from that copy without asking its computer', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 3);
    const w = await laptopWindow(a.laptop);
    const all = ['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3'];

    // Before anyone opens it, the conversation is already here.
    await a.laptop.desk.replica!.settled();
    expect(texts(await a.laptop.workspace.account.messages(session.id))).toEqual(all);

    const whole = await w.get(`/api/sessions/${session.id}`);
    expect(texts(whole.messages)).toEqual(all);
    expect(whole.remote).toMatchObject({ machine: { id: a.mini.id(), name: 'Mac mini' }, current: true, reachable: true });
    // A finished session with a whole copy: its computer was not asked anything.
    expect(a.laptop.desk.caller.connected(a.mini.id())).toBe(false);

    // Paged from the copy too.
    const pages: string[][] = [];
    let page = await w.get(`/api/sessions/${session.id}?last=2`);
    pages.unshift(texts(page.messages));
    while (page.page.before !== null) {
      page = await w.get(`/api/sessions/${session.id}?before=${encodeURIComponent(page.page.before)}&limit=2`);
      pages.unshift(texts(page.messages));
    }
    expect(pages.flat()).toEqual(all);

    // Another turn there reaches the copy through the account; it opens whole with the Mac mini switched off.
    await a.mini.runtime.reply(session.id, 'question 4');
    await a.mini.settle();
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await a.laptop.desk.replica!.settled();
    await a.mini.desk.setEnabled(false);
    const started = Date.now();
    const later = await w.get(`/api/sessions/${session.id}`);
    expect(Date.now() - started).toBeLessThan(300);
    expect(texts(later.messages)).toEqual([...all, 'question 4', 'answer 4']);
    expect(later.remote).toMatchObject({ current: true, reachable: true });
    // The relay carried no conversation in the clear.
    expect(a.relay.carried.some((f) => f.includes('question 4'))).toBe(false);
  });

  it('a copy behind its head opens at once, and what its computer answers is laid over it', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 2);
    const w = await laptopWindow(a.laptop);
    w.send({ type: 'watch', sessionId: session.id });
    // The head of the next turn arrives; its chunks are still on their way.
    a.service.held.withhold = (r) => r.list === null;
    await a.mini.runtime.reply(session.id, 'question 3');
    await a.mini.settle();
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await a.laptop.desk.replica!.settled();

    const first = await w.get(`/api/sessions/${session.id}`);
    expect(texts(first.messages)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2']);
    expect(first.remote).toMatchObject({ current: false, reachable: true });
    // A finished session is not watched there: there is no turn to stream.
    expect(a.laptop.desk.remote.watching(session.id)).toBe(false);

    await until(() => liveTexts(w, session.id).includes('answer 3'), 'what the Mac mini answered reaches the window');
    const after = await w.get(`/api/sessions/${session.id}`);
    expect(texts(after.messages)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3']);
    expect(after.remote).toMatchObject({ current: true, reachable: true });
  });

  it('a turn running there is watched there, and its output streams to the window', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop);
    w.send({ type: 'watch', sessionId: session.id });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    a.mini.fake.script = async (turn) => {
      turn.emit({ type: 'message', id: `a${turn.n}`, text: 'answer 2 so far', delta: 'answer 2 so far', done: false });
      await gate;
      turn.emit({ type: 'message', id: `a${turn.n}`, text: 'answer 2', delta: '', done: true });
    };
    await a.mini.runtime.reply(session.id, 'question 2');
    // Its head says it runs: the laptop asks the Mac mini for its live output.
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await until(() => a.laptop.desk.remote.watching(session.id) && a.laptop.desk.caller.connected(a.mini.id()), 'the laptop watches it there');
    // Opening it lays the newest part, read from there, over the copy.
    await w.get(`/api/sessions/${session.id}`);
    await until(() => liveTexts(w, session.id).includes('answer 2 so far'), 'the part streamed so far arrives');
    await new Promise((resolve) => setTimeout(resolve, 50)); // the watch request reaches the Mac mini
    release();
    await a.mini.settle();
    await until(() => liveTexts(w, session.id).includes('answer 2'), 'the finished answer arrives');
    expect(w.live.every((l) => l.sessionId === session.id)).toBe(true);
  });
});

describe('when the machine that runs it cannot be reached', () => {
  it('a whole copy never says so', async () => {
    const a = await account();
    const session = await remoteSession(a, 'claude', 2);
    const w = await laptopWindow(a.laptop);
    await a.laptop.desk.replica!.settled();
    await a.mini.desk.setEnabled(false);
    const away = await w.get(`/api/sessions/${session.id}`);
    expect(texts(away.messages)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2']);
    expect(away.remote).toMatchObject({ current: true, reachable: true });
    expect(away.remote.asOf).toBeLessThanOrEqual(Date.now());
  });

  it('a copy behind its head says the machine did not answer once it did not, and never waits for it', async () => {
    const a = await account();
    const session = await remoteSession(a, 'codex', 1);
    const w = await laptopWindow(a.laptop);
    a.service.held.withhold = (r) => r.list === null;
    await a.mini.runtime.reply(session.id, 'question 2');
    await a.mini.settle();
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await a.laptop.desk.replica!.settled();
    let losing = true;
    a.relay.lose((text) => losing && text.includes(`"to":"${a.mini.id()}"`));

    const started = Date.now();
    const first = await w.get(`/api/sessions/${session.id}`);
    expect(Date.now() - started).toBeLessThan(300);
    expect(texts(first.messages)).toEqual(['question 1', 'answer 1']);
    expect(first.remote).toMatchObject({ current: false, reachable: true });
    await until(async () => (await w.get(`/api/sessions/${session.id}`)).remote.reachable === false, 'it says the Mac mini did not answer');

    // Try again asks afresh, even while the computer rests; once the relay carries it, the answer is laid over.
    losing = false;
    await w.get(`/api/sessions/${session.id}?again=1`);
    await until(async () => (await w.get(`/api/sessions/${session.id}`)).remote.current === true, 'Try again reads it from the Mac mini');
    expect(texts((await w.get(`/api/sessions/${session.id}`)).messages)).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2']);
  });

  it('a machine removed from the account is never called again', async () => {
    const a = await account();
    await remoteSession(a, 'opencode', 1);
    expect((await a.laptop.desk.caller.request(a.mini.id(), 'session.read', { sessionId: 'x', last: 1 })).ok).toBe(false);
    expect(a.laptop.desk.caller.connected(a.mini.id())).toBe(true);
    await a.laptop.desk.removeDevice(a.mini.id());
    expect(a.laptop.desk.caller.connected(a.mini.id())).toBe(false);
    await expect(a.laptop.desk.caller.request(a.mini.id(), 'session.read', { sessionId: 'x', last: 1 })).rejects.toThrow('That computer is not in your account.');
  });
});

describe('what the caller believes', () => {
  it('a live push for a session not watched there, or from another computer, is dropped', async () => {
    const a = await account();
    const got: string[] = [];
    a.laptop.desk.remote.onLive((id) => got.push(id));
    a.laptop.desk.remote.watch(a.mini.id(), 's-watched');
    a.laptop.desk.remote.push(a.mini.id(), { type: 'live', sessionId: 's-other', patch: { messages: [] } });
    a.laptop.desk.remote.push('someone-else', { type: 'live', sessionId: 's-watched', patch: { messages: [] } });
    a.laptop.desk.remote.push(a.mini.id(), { type: 'live', sessionId: 's-watched', patch: { status: 'Thinking…', files: [{ path: 'x' }] } });
    expect(got).toEqual(['s-watched']);
  });

  it('a frame not sealed by the machine called is dropped, and the channel carries on', async () => {
    const a = await account();
    const session = await remoteSession(a, 'claude', 1);
    expect((await a.laptop.desk.remote.read(a.mini.id(), session.id, { last: 2 })).ok).toBe(true);
    // A forged response in the clear that claims a result is not believed.
    const forged = { v: 3, from: a.mini.id(), to: a.laptop.id(), kind: 'response', id: 'x1', replyTo: 'c999', body: { ok: true, result: { messages: [] } } };
    a.service.sockets.find((s) => s.deviceId === a.laptop.id() && s.closedWith === null)!.events.message(JSON.stringify(forged));
    const again = await a.laptop.desk.remote.read(a.mini.id(), session.id, { last: 2 });
    expect(again.ok && texts(again.page.messages)).toEqual(['question 1', 'answer 1']);
  });

  it('a slow answer over an open channel does not stop the next ask', async () => {
    const a = await account();
    const session = await remoteSession(a, 'claude', 1);
    expect((await a.laptop.desk.remote.read(a.mini.id(), session.id, { last: 1 })).ok).toBe(true);
    let losing = true;
    a.relay.lose((text) => losing && text.includes(`"to":"${a.mini.id()}"`));
    const slow = await a.laptop.desk.remote.read(a.mini.id(), session.id, { last: 1 }, { timeoutMs: 100 });
    expect(slow).toMatchObject({ ok: false, reached: false });
    losing = false;
    expect((await a.laptop.desk.remote.read(a.mini.id(), session.id, { last: 1 })).ok).toBe(true);
  });
});
