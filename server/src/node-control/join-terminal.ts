// `kestrel node join` in a real terminal: lines printed, answers read from the keyboard, and Ctrl-C or a closed
// terminal stopping the join (the node withdraws what was under way). The conversation itself is join-client.ts; how
// it looks is join-draw.ts, or the interactive screen (worker-onboarding/) where it can work.
import { createInterface } from 'node:readline';
import { computerName } from '../connect/link/start.ts';
import { runJoinClient, STOPPED_EXIT, type JoinClientOptions, type JoinTerminal } from './join-client.ts';
import { terminalJoinStyle } from './join-draw.ts';
import { openWorkerSession } from './worker-onboarding/open.ts';
import { WorkerSession } from './worker-onboarding/session.ts';

export interface JoinTerminalOptions extends JoinClientOptions {
  /** Configure's screen, when it has one: the join is drawn there, under its section. */
  screen?: WorkerSession | null;
}

/** The parts the join has, as the screen's progress line names them (join-flow.ts). */
const JOIN_SECTIONS = ['Sign in', 'Let this node in', 'Confirm'] as const;
const WITHDRAWN = 'Stopped. The join was withdrawn.';

/** The screen's side of the join: events to its frame, the code typed in its input, Ctrl+C withdrawing. */
function screenTerminal(screen: WorkerSession, options: JoinTerminalOptions): JoinTerminal {
  const io = screen.io(options.section ?? null);
  return {
    out: () => undefined,
    err: () => undefined,
    take: io.say,
    ask: async (prompt) => {
      const answer = await screen.ask(prompt, WorkerSession.CODE_HINT);
      if (answer === null) throw new Error('stopped');
      return answer;
    },
  };
}

function lineTerminal(plain: boolean): { terminal: JoinTerminal; waiting: Set<(error: Error) => void>; close(): void; onStop(stop: () => void): void } {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: !plain && process.stdin.isTTY === true });
  const waiting = new Set<(error: Error) => void>();
  return {
    waiting,
    terminal: {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      ask: (prompt) =>
        new Promise<string>((resolve, reject) => {
          waiting.add(reject);
          lines.question(prompt, (answer) => {
            waiting.delete(reject);
            resolve(answer);
          });
        }),
    },
    close: () => lines.close(),
    onStop: (stop) => {
      lines.on('SIGINT', stop);
      lines.on('close', stop);
    },
  };
}

/**
 * `options.next`: whether the closing "Next:" line is drawn; `options.section`: drawn inside configure's section;
 * `options.screen`: configure's screen. Run alone at a terminal that can, the join opens a screen of its own.
 */
export async function joinFromTerminal(path: string, options: JoinTerminalOptions = { next: true }): Promise<number> {
  const style = terminalJoinStyle();
  const own = options.screen === undefined && options.section === undefined
    ? await openWorkerSession({ name: 'Pair this worker', node: computerName(), sections: JOIN_SECTIONS, stoppedText: WITHDRAWN })
    : null;
  const screen = options.screen ?? own;
  const lines = screen ? null : lineTerminal(style.plain);
  const waiting = lines?.waiting ?? new Set<(error: Error) => void>();
  let finished = false;
  const { done, stop } = runJoinClient(path, screen ? screenTerminal(screen, options) : lines!.terminal, style, options);
  const stopped = () => {
    if (finished) return;
    finished = true;
    // Stopped at a question: what is said next starts on a line of its own, not after the prompt.
    if (waiting.size > 0) console.log('');
    for (const reject of waiting) reject(new Error('stopped'));
    stop();
  };
  lines?.onStop(stopped);
  // On the screen Ctrl+C is a key, not a signal: it withdraws the join the same way.
  const offScreen = screen?.onStop(stopped);
  process.once('SIGINT', stopped);
  process.once('SIGHUP', stopped);
  process.once('SIGTERM', stopped);
  let code: number;
  try {
    code = await done;
  } catch {
    code = STOPPED_EXIT;
  } finally {
    finished = true;
    offScreen?.();
    process.off('SIGINT', stopped);
    process.off('SIGHUP', stopped);
    process.off('SIGTERM', stopped);
    lines?.close();
  }
  if (own) await concludeOwn(own, code);
  return code;
}

/** A command's own screen at its end: its closing frame, or, stopped, let go and the reason written plainly. */
export async function concludeOwn(screen: WorkerSession, code: number): Promise<void> {
  if (!screen.stopped && code !== STOPPED_EXIT) return screen.finish();
  await screen.close();
  if (screen.ended) process.stderr.write(`${screen.ended.text}\n`);
}
