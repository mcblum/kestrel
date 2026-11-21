// Running a fenced code block from the conversation in the session's Run terminal. Shared so the
// UI decides which blocks get a Run button by the same rules the server checks, and so the
// server's end-of-run detection is testable without a shell.

/** The shell that runs a block. Everything shell-like but zsh runs in bash. */
export type RunShell = 'bash' | 'zsh';

export interface RunnableBlock {
  /** What runs: the block's text, or for a transcript only its `$ ` command lines. */
  script: string;
  shell: RunShell;
}

/** A block this long or longer is not offered (or accepted) for running. */
export const MAX_RUN_SCRIPT_CHARS = 20_000;

/** The Run terminal's tab title. */
export const RUN_TERMINAL_TITLE = 'Run';

const PLAIN_SHELLS: Record<string, RunShell> = { bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'zsh' };
const TRANSCRIPTS = new Set(['console', 'shell-session']);
const PROMPT = /^\$ ?/;

/** A transcript's commands: the lines that start with `$ `, prompt removed. Output lines are dropped. */
function transcriptCommands(text: string): string | null {
  const commands = text
    .split('\n')
    .filter((line) => line.startsWith('$ ') || line === '$')
    .map((line) => line.replace(PROMPT, ''));
  return commands.length ? commands.join('\n') : null;
}

/**
 * What a fenced block would run, or null when it gets no Run button: not a shell language, or
 * nothing but blank lines. `lang` is the fence's language (`bash`, `console`…), any case.
 */
export function runnableBlock(lang: string | null | undefined, text: string): RunnableBlock | null {
  const key = (lang ?? '').trim().toLowerCase();
  const shell = PLAIN_SHELLS[key] ?? (TRANSCRIPTS.has(key) ? 'bash' : null);
  if (!shell) return null;
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const script = TRANSCRIPTS.has(key) ? (transcriptCommands(body) ?? body) : body;
  if (!script.trim() || script.length >= MAX_RUN_SCRIPT_CHARS) return null;
  return { script, shell };
}

// ---- the end of a run -----------------------------------------------------------------------

/**
 * The run's wrapper prints this when the block has finished: an OSC sequence terminals ignore,
 * carrying the run's own nonce and the exit code. The command line typed into the shell does not
 * contain it (the wrapper is a file), so its echo cannot be mistaken for the end.
 */
export const runEndMarker = (nonce: string, code: number): string => `\x1b]777;kestrel-run;${nonce};${code}\x07`;

/** The printf format that prints the marker with the shell's `$?`, for the wrapper script. */
export const runEndPrintf = (nonce: string): string => `\\033]777;kestrel-run;${nonce};%d\\007`;

export interface RunScan {
  /** The exit code once the marker has been seen, else null. */
  code: number | null;
  /** The tail to keep and prepend to the next output, so a marker split across chunks is still found. */
  carry: string;
}

/** Look for the end of run `nonce` in `carry + chunk`. */
export function scanRunEnd(carry: string, chunk: string, nonce: string): RunScan {
  const text = carry + chunk;
  const prefix = `\x1b]777;kestrel-run;${nonce};`;
  const at = text.indexOf(prefix);
  if (at >= 0) {
    const rest = text.slice(at + prefix.length);
    const match = /^(\d{1,3})\x07/.exec(rest);
    if (match) return { code: Number(match[1]), carry: '' };
    if (/^\d{0,3}$/.test(rest)) return { code: null, carry: text.slice(at) }; // the code is still coming
  }
  // Keep only what could be the start of a marker cut short.
  return { code: null, carry: text.slice(-(prefix.length + 4)) };
}

/** Quote a string for a POSIX shell. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
