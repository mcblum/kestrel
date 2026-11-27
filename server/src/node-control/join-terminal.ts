// `kestrel node join` in a real terminal: lines printed, answers read from the keyboard, and Ctrl-C or a closed
// terminal stopping the join (the node withdraws what was under way). The conversation itself is join-client.ts; how
// it looks is join-draw.ts, plain ASCII when the output is not a terminal, NO_COLOR is set or TERM is dumb.
import { createInterface } from 'node:readline';
import { runJoinClient, STOPPED_EXIT } from './join-client.ts';
import { joinStyleOf } from './join-draw.ts';

/** `options.next`: whether the closing "Next:" line is drawn (`kestrel node configure` goes on to it itself). */
export async function joinFromTerminal(path: string, options: { next: boolean } = { next: true }): Promise<number> {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  const waiting = new Set<(error: Error) => void>();
  let finished = false;
  const { done, stop } = runJoinClient(path, {
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
  }, joinStyleOf({ isTTY: process.stdout.isTTY === true, columns: process.stdout.columns }, process.env), options);
  const stopped = () => {
    if (finished) return;
    finished = true;
    for (const reject of waiting) reject(new Error('stopped'));
    stop();
  };
  lines.on('SIGINT', stopped);
  lines.on('close', stopped);
  process.once('SIGHUP', stopped);
  process.once('SIGTERM', stopped);
  try {
    return await done;
  } catch {
    return STOPPED_EXIT;
  } finally {
    finished = true;
    lines.close();
  }
}
