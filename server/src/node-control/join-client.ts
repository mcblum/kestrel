// The terminal's side of `kestrel node join`: it sends the request, draws what the node says (join-draw.ts), asks the
// person for each answer the node asks for and sends it back, until the node says how it ended. Closing it (Ctrl-C, a
// closed window) closes the connection, and the node withdraws what was under way (join-socket.ts).
import { connect, type Socket } from 'node:net';
import { parseJoinEvent, type JoinStep, type NodeJoinAnswer, type NodeJoinEvent } from '../shared/node-commands.ts';
import { noNodeRunning } from './client.ts';
import { drawJoinEvent, JOIN_DRAW_START, nestedEvent, type JoinStyle } from './join-draw.ts';

export interface JoinTerminal {
  out(line: string): void;
  err(line: string): void;
  /** Asks the person for one line; rejects when the terminal is closed. */
  ask(prompt: string): Promise<string>;
  /** Takes each event itself instead of drawn lines (the interactive screen, which places it under a section itself). */
  take?(event: NodeJoinEvent): void;
}

const NOT_UNDERSTOOD = 'The node sent something this version of kestrel does not understand, so the join was stopped.';

/** Plain ASCII at 80 columns: what a log or a script reads, and what tests read. */
export const PLAIN_JOIN_STYLE: JoinStyle = { plain: true, width: 80 };

/** Exit code for a join the person stopped (Ctrl-C, a closed terminal). */
export const STOPPED_EXIT = 130;

/**
 * Holds the conversation (`options.next`: whether the closing "Next:" line is drawn); `done` resolves with the exit code (0 in, 1 not, `STOPPED_EXIT` stopped). `stop` ends it
 * from this side (Ctrl-C): the connection closes, and the node withdraws.
 */
export interface JoinClientOptions {
  /** Whether the closing "Next:" line is drawn. */
  next: boolean;
  /** Drawn inside this section of `kestrel node configure`: its title left out, its steps as subheadings. */
  section?: JoinStep;
}

export function runJoinClient(path: string, terminal: JoinTerminal, style: JoinStyle = PLAIN_JOIN_STYLE, options: JoinClientOptions = { next: true }): { done: Promise<number>; stop(): void } {
  const socket: Socket = connect(path);
  let end: (code: number, last?: NodeJoinEvent & { event: 'end' }) => void = () => undefined;
  // Inside configure, something was printed above (the section's heading and question): the first part is set off.
  let drawing = options.section === undefined ? JOIN_DRAW_START : { printed: true, blank: false };
  /** Draws one event; returns the prompt of an `ask`. */
  const draw = (given: NodeJoinEvent): string | null => {
    if (terminal.take) {
      terminal.take(given);
      return given.event === 'ask' ? given.prompt : null;
    }
    const event = options.section === undefined ? given : nestedEvent(given, options.section);
    if (!event) return null;
    const drawn = drawJoinEvent(event, drawing, style);
    for (const line of drawn.lines) (drawn.toErr ? terminal.err : terminal.out)(line);
    // The answer typed after a prompt ends its line.
    drawing = drawn.prompt === null ? drawn.state : { printed: true, blank: false };
    return drawn.prompt;
  };
  const failed = (text: string): NodeJoinEvent & { event: 'end' } => ({ event: 'end', ok: false, text });
  const done = new Promise<number>((resolve) => {
    let received = '';
    let ended = false;
    end = (code, last) => {
      if (ended) return;
      ended = true;
      // Inside `kestrel node configure` the last line names no next command: setup goes on to it.
      if (last) draw(options.next ? last : { event: 'end', ok: last.ok, text: last.text });
      socket.end();
      resolve(code);
    };
    const handle = (line: string) => {
      const event = parseJoinEvent(line);
      if (!event) return end(1, failed(NOT_UNDERSTOOD));
      if (event.event === 'end') return end(event.ok ? 0 : 1, event);
      const prompt = draw(event);
      if (prompt === null) return;
      terminal.ask(prompt).then(
        (answer) => !ended && socket.write(`${JSON.stringify({ answer: answer.trim() } satisfies NodeJoinAnswer)}\n`),
        () => end(STOPPED_EXIT),
      );
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ command: 'join' })}\n`));
    socket.on('data', (chunk: string) => {
      received += chunk;
      for (let at = received.indexOf('\n'); at !== -1 && !ended; at = received.indexOf('\n')) {
        const line = received.slice(0, at);
        received = received.slice(at + 1);
        handle(line);
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => end(1, failed(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? noNodeRunning(path) : `Could not reach the node at ${path}: ${error.message}`)));
    socket.once('close', () => end(1, failed('The node closed the connection before the join finished.')));
  });
  return {
    done,
    stop: () => {
      end(STOPPED_EXIT, failed('Stopped. The join was withdrawn.'));
      socket.destroy();
    },
  };
}
