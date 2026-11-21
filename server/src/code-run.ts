// The files behind one run of a code block: the block itself and a small POSIX wrapper that
// shows what runs, runs it in the session folder (stopping at the first failing command), cleans
// up and prints the end marker with the exit code (shared/code-run.ts). The wrapper traps Ctrl-C
// for itself only, so stopping the block still lets it print the marker.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEndPrintf, shellQuote, type RunnableBlock } from './shared/code-run.ts';

export interface PreparedRun {
  nonce: string;
  /** The folder holding the run's files; the wrapper removes it, the server too if the shell goes first. */
  dir: string;
  /** What is typed into the Run terminal's shell. */
  commandLine: string;
}

/** Exit code a shell reports for a command stopped by Ctrl-C. */
const INTERRUPTED = 130;

/** The wrapper's text. `dir` holds `block.sh`; `folder` is where the block runs. */
export function wrapperText(dir: string, folder: string, block: RunnableBlock, nonce: string): string {
  const shown = block.script.split('\n').map((line) => shellQuote(`$ ${line}`)).join(' ');
  return [
    'trap : INT',
    `printf '\\033[2m%s\\033[0m\\n' ${shown}`,
    `if cd -- ${shellQuote(folder)}; then ${block.shell} -e ${shellQuote(join(dir, 'block.sh'))}; code=$?; else code=1; fi`,
    `rm -rf -- ${shellQuote(dir)}`,
    `if [ "$code" -eq ${INTERRUPTED} ]; then printf '\\033[2m[stopped]\\033[0m\\n'; elif [ "$code" -ne 0 ]; then printf '\\033[2m[exit %d]\\033[0m\\n' "$code"; fi`,
    `printf '${runEndPrintf(nonce)}' "$code"`,
    '',
  ].join('\n');
}

/** `/tmp` where there is one: the command typed into the shell stays short enough to read. */
const runRoot = (): string => (process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir());

/** Write a run's files to a fresh private folder (mode 700) under the temp folder. */
export function prepareRun(folder: string, block: RunnableBlock): PreparedRun {
  const nonce = randomBytes(8).toString('hex');
  const dir = mkdtempSync(join(runRoot(), 'kestrel-run-'));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'block.sh'), `${block.script}\n`, { mode: 0o600 });
  const wrapper = join(dir, 'run.sh');
  writeFileSync(wrapper, wrapperText(dir, folder, block, nonce), { mode: 0o600 });
  // Ctrl-U first clears anything half-typed at the prompt; the leading space keeps it out of history.
  return { nonce, dir, commandLine: `\x15 sh ${shellQuote(wrapper)}\r` };
}

/** Remove a run's files when the wrapper could not (its shell ended first). */
export function discardRun(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort: it lives in the temp folder
  }
}
