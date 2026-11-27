// The node's side of `kestrel-node join` on the control socket: the one command that is a conversation
// (shared/node-commands.ts, `NodeJoinEvent`). The node says lines and asks for answers; the terminal sends one
// answer line per question. A line that is not an answer, or comes when nothing is asked, is told so and the
// conversation goes on; a line too long ends it. The terminal going away aborts the run, which withdraws.
import type { Socket } from 'node:net';
import { NODE_REQUEST_MAX_BYTES, parseJoinAnswer, type JoinSaid, type JoinStep, type NodeJoinEvent } from '../shared/node-commands.ts';

/** What a run of `join` says and asks through. `ask` rejects once the terminal has gone. */
export interface JoinIo {
  say(line: JoinSaid): void;
  ask(step: JoinStep, prompt: string): Promise<string>;
}

export interface JoinEnd {
  ok: boolean;
  text: string;
  /** The command to run next, when there is one. */
  next?: string;
}

export type JoinRun = (io: JoinIo, signal: AbortSignal) => Promise<JoinEnd>;

/** The longest a join may take: the sign-in's code and the request to join each last ten minutes. */
export const JOIN_LIMIT_MS = 30 * 60_000;

export const NOTHING_ASKED = 'Nothing is being asked now.';
export const ANSWER_TOO_LONG = 'That answer is too long, so the join was stopped. Run "kestrel-node join" again.';
const TOOK_TOO_LONG = 'The join took too long and was stopped. Run "kestrel-node join" again.';

/** The terminal went away (Ctrl-C, a closed window): what was under way is withdrawn. */
export class TerminalGone extends Error {
  constructor() {
    super('The terminal closed, so the join was withdrawn.');
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Holds the conversation on `socket`; `leftover` is what came after the request line. */
export function converse(socket: Socket, leftover: string, run: JoinRun, limitMs = JOIN_LIMIT_MS): void {
  const abort = new AbortController();
  let received = leftover;
  let waiting: { step: JoinStep; prompt: string; resolve(answer: string): void; reject(error: Error): void } | null = null;
  let ended = false;
  const send = (event: NodeJoinEvent) => {
    if (!ended && socket.writable) socket.write(`${JSON.stringify(event)}\n`);
  };
  const finish = (end: JoinEnd) => {
    if (ended) return;
    send({ event: 'end', ...end });
    ended = true;
    clearTimeout(limit);
    socket.end();
  };
  const stop = (end: JoinEnd) => {
    abort.abort();
    finish(end);
  };
  abort.signal.addEventListener('abort', () => {
    const asked = waiting;
    waiting = null;
    asked?.reject(new TerminalGone());
  });
  socket.setTimeout(0);
  const limit = setTimeout(() => stop({ ok: false, text: TOOK_TOO_LONG }), limitMs);
  limit.unref?.();
  socket.on('close', () => {
    clearTimeout(limit);
    ended = true;
    abort.abort();
  });

  const take = (line: string) => {
    if (!line.trim()) return;
    const parsed = parseJoinAnswer(line);
    if (!parsed.ok) {
      send({ event: 'say', step: waiting?.step ?? 0, kind: 'problem', text: parsed.reason });
      // The question still stands: asked again, so the terminal answers it.
      if (waiting) send({ event: 'ask', step: waiting.step, prompt: waiting.prompt });
      return;
    }
    const asked = waiting;
    if (!asked) return send({ event: 'say', step: 0, kind: 'problem', text: NOTHING_ASKED });
    waiting = null;
    asked.resolve(parsed.answer);
  };
  const read = () => {
    for (let end = received.indexOf('\n'); end !== -1; end = received.indexOf('\n')) {
      take(received.slice(0, end));
      received = received.slice(end + 1);
    }
    if (Buffer.byteLength(received) > NODE_REQUEST_MAX_BYTES) stop({ ok: false, text: ANSWER_TOO_LONG });
  };
  socket.on('data', (chunk: string) => {
    if (ended) return;
    received += chunk;
    read();
  });

  const io: JoinIo = {
    say: (line) => send({ event: 'say', ...line }),
    ask: (step, prompt) =>
      new Promise<string>((resolve, reject) => {
        if (abort.signal.aborted) return reject(new TerminalGone());
        waiting?.reject(new Error('Asked again before an answer.'));
        waiting = { step, prompt, resolve, reject };
        send({ event: 'ask', step, prompt });
      }),
  };
  read();
  run(io, abort.signal).then(finish, (error: unknown) => finish({ ok: false, text: message(error) }));
}
