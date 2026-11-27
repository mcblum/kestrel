// `join` on the control socket as a conversation of typed lines: what the node says and asks, what it does with an
// answer that is not one, one that comes when nothing is asked, one too long, and the terminal going away.
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NODE_ANSWER_MAX_CHARS, parseJoinAnswer, parseJoinEvent, type NodeJoinEvent } from '../shared/node-commands.ts';
import { until } from '../test-agent.ts';
import { listenControl, type ControlSocket } from './control-socket.ts';
import { runJoinClient, STOPPED_EXIT } from './join-client.ts';
import { ANSWER_TOO_LONG, NOTHING_ASKED, TerminalGone, type JoinRun } from './join-socket.ts';
import { nodeSocketPath } from './socket-path.ts';

let dir: string;
let control: ControlSocket | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kn-'));
  control = null;
});
afterEach(async () => {
  await control?.close();
  rmSync(dir, { recursive: true, force: true });
});

const listen = async (run: JoinRun) => (control = await listenControl(nodeSocketPath(dir), { status: async () => Promise.reject(new Error('not here')), stop: () => undefined, join: run, uninstall: async () => ({ ok: false, reason: 'not here' }), agents: async () => [], git: async () => ({ name: 'n', repositories: [], others: [], accountUnknown: null, othersUnknown: null }) }));

/** A raw terminal: sends `lines` as they are asked for (or all at once), and collects every event. */
function rawTerminal(path: string, send: (event: NodeJoinEvent, write: (text: string) => void) => void, first = '{"command":"join"}\n') {
  const events: NodeJoinEvent[] = [];
  const socket = connect(path);
  const closed = new Promise<NodeJoinEvent[]>((resolve) => socket.once('close', () => resolve(events)));
  let received = '';
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(first));
  socket.on('data', (chunk: string) => {
    received += chunk;
    for (let at = received.indexOf('\n'); at !== -1; at = received.indexOf('\n')) {
      const event = parseJoinEvent(received.slice(0, at));
      received = received.slice(at + 1);
      if (event) {
        events.push(event);
        send(event, (text) => socket.write(text));
      }
    }
  });
  return { closed, socket };
}

describe('the join conversation on the control socket', () => {
  test('says, asks, takes the answer and ends with how it went', async () => {
    // Arrange
    const { path } = await listen(async (io) => {
      io.say({ step: 1, kind: 'line', text: 'Hello.' });
      const code = await io.ask(1, 'Code: ');
      return { ok: code === '157 640', text: `Got ${code}.` };
    });
    // Act
    const { closed } = rawTerminal(path, (event, write) => event.event === 'ask' && write('{"answer":"157 640"}\n'));
    // Assert
    expect(await closed).toEqual([
      { event: 'say', step: 1, kind: 'line', text: 'Hello.' },
      { event: 'ask', step: 1, prompt: 'Code: ' },
      { event: 'end', ok: true, text: 'Got 157 640.' },
    ]);
  });

  test('a line that is not an answer is told so, and the question is asked again', async () => {
    const { path } = await listen(async (io) => ({ ok: true, text: await io.ask(3, 'Code: ') }));
    let tries = 0;
    const { closed } = rawTerminal(path, (event, write) => {
      if (event.event !== 'ask') return;
      tries += 1;
      write(tries === 1 ? 'not json\n' : tries === 2 ? '{"answer":42}\n' : '{"answer":"123456"}\n');
    });
    const events = await closed;
    expect(events.filter((e) => e.event === 'ask')).toHaveLength(3);
    expect(events.filter((e) => e.event === 'say')).toEqual([
      { event: 'say', step: 3, kind: 'problem', text: 'That was not an answer: send one line of JSON, like {"answer":"157 640"}.' },
      { event: 'say', step: 3, kind: 'problem', text: 'An answer is text: {"answer":"157 640"}.' },
    ]);
    expect(events.at(-1)).toEqual({ event: 'end', ok: true, text: '123456' });
  });

  test('an answer when nothing is asked is told so and taken for nothing', async () => {
    let release: () => void = () => undefined;
    const { path } = await listen(async (io) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { ok: true, text: await io.ask(3, 'Code: ') };
    });
    const { closed, socket } = rawTerminal(path, (event, write) => event.event === 'ask' && write('{"answer":"222222"}\n'));
    socket.once('connect', () => socket.write('{"answer":"111111"}\n'));
    setTimeout(() => release(), 50);
    const events = await closed;
    expect(events[0]).toEqual({ event: 'say', step: 0, kind: 'problem', text: NOTHING_ASKED });
    expect(events.at(-1)).toEqual({ event: 'end', ok: true, text: '222222' });
  });

  test('a line longer than a request may be ends the conversation and withdraws', async () => {
    let aborted = false;
    const { path } = await listen(async (io, signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return { ok: true, text: await io.ask(3, 'Code: ') };
    });
    const { closed } = rawTerminal(path, (event, write) => event.event === 'ask' && write('x'.repeat(5000)));
    expect((await closed).at(-1)).toEqual({ event: 'end', ok: false, text: ANSWER_TOO_LONG });
    expect(aborted).toBe(true);
  });

  test('the terminal going away aborts the run, and a waiting question rejects', async () => {
    let gone: unknown = null;
    const { path } = await listen(async (io) => {
      try {
        await io.ask(3, 'Code: ');
      } catch (error) {
        gone = error;
      }
      return { ok: false, text: 'withdrawn' };
    });
    const { socket } = rawTerminal(path, (event) => event.event === 'ask' && socket.destroy());
    await until(() => gone !== null, 'the question rejects');
    expect(gone).toBeInstanceOf(TerminalGone);
  });

  test('the terminal’s client prints what is said, answers what is asked, and exits by the end', async () => {
    const { path } = await listen(async (io) => {
      io.say({ step: 2, kind: 'code', code: '482 913' });
      const code = await io.ask(3, 'The code MacBook Pro shows: ');
      return { ok: code === '157 640', text: 'Worker node 1 is in your account.', next: 'kestrel node status' };
    });
    const out: string[] = [];
    const asked: string[] = [];
    const { done } = runJoinClient(path, { out: (l) => out.push(l), err: (l) => out.push(`err: ${l}`), ask: async (prompt) => (asked.push(prompt), ' 157 640 ') });
    expect(await done).toBe(0);
    expect(asked).toEqual(['   The code MacBook Pro shows: ']);
    // The prompt and the answer typed after it are the terminal's line between the two blanks.
    expect(out).toEqual(['       482 913', '', '', 'ok: Worker node 1 is in your account.', '', 'Next: kestrel node status']);
  });

  test('the terminal’s client stopped (Ctrl-C) exits 130 and the node is told', async () => {
    let aborted = false;
    const { path } = await listen(async (io, signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      await io.ask(3, 'Code: ').catch(() => undefined);
      return { ok: false, text: 'withdrawn' };
    });
    let stop: () => void = () => undefined;
    const client = runJoinClient(path, { out: () => undefined, err: () => undefined, ask: () => (stop(), new Promise(() => undefined)) });
    stop = client.stop;
    expect(await client.done).toBe(STOPPED_EXIT);
    await until(() => aborted, 'the node withdraws');
  });
});

describe('the join lines', () => {
  test('an answer is one line of JSON with text no longer than a code needs', () => {
    expect(parseJoinAnswer('{"answer":"157 640"}')).toEqual({ ok: true, answer: '157 640' });
    expect(parseJoinAnswer('[]')).toMatchObject({ ok: false });
    expect(parseJoinAnswer('{"answer":null}')).toMatchObject({ ok: false });
    expect(parseJoinAnswer(JSON.stringify({ answer: 'x'.repeat(NODE_ANSWER_MAX_CHARS + 1) }))).toEqual({ ok: false, reason: `An answer is at most ${NODE_ANSWER_MAX_CHARS} characters.` });
  });

  test('an event the terminal does not know is not read as one; a plain refusal is read as the end', () => {
    expect(parseJoinEvent('{"event":"run","command":"rm"}')).toBeNull();
    expect(parseJoinEvent('{"event":"say"}')).toBeNull();
    expect(parseJoinEvent('{"event":"say","text":"old shape"}')).toBeNull();
    expect(parseJoinEvent('{"event":"say","step":7,"kind":"line","text":"no such step"}')).toBeNull();
    expect(parseJoinEvent('{"event":"say","step":1,"kind":"shout","text":"no such kind"}')).toBeNull();
    expect(parseJoinEvent('{"event":"say","step":1,"kind":"field","label":"Open"}')).toBeNull();
    expect(parseJoinEvent('{"event":"ask","prompt":"no step"}')).toBeNull();
    expect(parseJoinEvent('nonsense')).toBeNull();
    expect(parseJoinEvent('{"event":"say","step":1,"kind":"field","label":"Code","value":"WDJB-MJHT","note":"works for 10 minutes","extra":1}')).toEqual({ event: 'say', step: 1, kind: 'field', label: 'Code', value: 'WDJB-MJHT', note: 'works for 10 minutes' });
    expect(parseJoinEvent('{"event":"say","step":2,"kind":"code","code":"482 913"}')).toEqual({ event: 'say', step: 2, kind: 'code', code: '482 913' });
    expect(parseJoinEvent('{"event":"end","ok":true,"text":"In.","next":"kestrel node status"}')).toEqual({ event: 'end', ok: true, text: 'In.', next: 'kestrel node status' });
    expect(parseJoinEvent('{"ok":false,"reason":"The node is still starting."}')).toEqual({ event: 'end', ok: false, text: 'The node is still starting.' });
  });
});
