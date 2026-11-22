// Signing an agent in from Kestrel, for the agents whose own program can do it by opening a page in
// the browser (`claude auth login`, `codex login`). Kestrel starts that program, shows the page it
// names, and waits for it to end: the sign-in is the agent's own, kept where the agent keeps it.
// Kestrel never sees a password, a token or a key. One sign-in per agent at a time.
import { spawn } from 'node:child_process';
import type { SignInProgress } from '../shared/sign-in.ts';

export type { SignInProgress } from '../shared/sign-in.ts';

type Env = Record<string, string | undefined>;

export interface AgentSignIn {
  /** Begins a sign-in, or joins the one under way. Answers once the page is known, or it has ended. */
  start(): Promise<SignInProgress>;
  /** Answers when the sign-in under way ends; at once when none is. */
  wait(): Promise<SignInProgress>;
  /** Hands the program a code the sign-in page showed, for a browser that could not hand it over itself. */
  code(text: string): void;
  cancel(): void;
}

export interface SignInCommand {
  file: string;
  args: readonly string[];
  env: Env;
  /** A Windows .cmd is started through the shell (find-program.ts, `spawnTarget`). */
  shell?: boolean;
}

export interface CliSignInOptions {
  /** The program that signs in, or null when there is none on this computer. */
  command(): SignInCommand | null;
  /** What to say when there is none. */
  missing: string;
  /** Called once a sign-in succeeds, so what was known about the agent is asked again. */
  onDone?(): void;
  /** How long a sign-in may wait on the browser. */
  limitMs?: number;
  /** How long `start` waits for the program to name its page before answering without one. */
  urlWaitMs?: number;
}

export const SIGN_IN_LIMIT_MS = 10 * 60_000;
const URL_WAIT_MS = 5_000;
const TAIL_CHARS = 2_000;
const MAX_CODE = 500;
const PAGE = /https:\/\/[^\s"'<>]+/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The page a sign-in program asks the user to open: the first https address it prints. Pure. */
export function signInPage(output: string): string | null {
  return PAGE.exec(output.replace(ANSI, ''))?.[0] ?? null;
}

/** Why a sign-in program ended badly, from what it printed: its last line, without the page or a prompt. Pure. */
export function signInFailure(output: string, code: number | null): string {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    // A prompt ("Paste code here > ") ends with no line break, so what follows it is on its line.
    .map((line) => line.replace(/^[^>]*>\s+(?=\S)/, '').trim())
    .filter((line) => line && !PAGE.test(line) && !/>\s*$/.test(line));
  return lines.at(-1) ?? `The sign-in program ended with exit code ${code ?? 'unknown'}.`;
}

interface Run {
  progress: SignInProgress;
  /** Settles once the page is known or the run has ended. */
  known: Promise<void>;
  ended: Promise<SignInProgress>;
  code(text: string): void;
  cancel(): void;
}

/** A sign-in done by running the agent's own login command. */
export function cliSignIn(options: CliSignInOptions): AgentSignIn {
  let run: Run | null = null;
  let last: SignInProgress = { state: 'idle' };

  const begin = (command: SignInCommand): Run => {
    let output = '';
    let cancelled = false;
    let over = false;
    let nowKnown: () => void = () => undefined;
    let nowEnded: (progress: SignInProgress) => void = () => undefined;
    const child = spawn(command.file, [...command.args], { env: command.env as NodeJS.ProcessEnv, shell: command.shell ?? false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => child.kill();
    const started: Run = {
      progress: { state: 'waiting', url: null },
      known: new Promise<void>((resolve) => (nowKnown = resolve)),
      ended: new Promise<SignInProgress>((resolve) => (nowEnded = resolve)),
      code: (text) => child.stdin.write(`${text}\n`),
      cancel: () => {
        cancelled = true;
        kill();
      },
    };
    const finish = (progress: SignInProgress) => {
      if (over) return;
      over = true;
      clearTimeout(limit);
      clearTimeout(urlWait);
      process.off('exit', kill);
      started.progress = progress;
      last = progress;
      if (run === started) run = null;
      nowKnown();
      nowEnded(progress);
      if (progress.state === 'done') options.onDone?.();
    };
    const heard = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-TAIL_CHARS * 4);
      if (over || started.progress.state !== 'waiting' || started.progress.url) return;
      const url = signInPage(output);
      if (!url) return;
      started.progress = { state: 'waiting', url };
      nowKnown();
    };
    const limit = setTimeout(() => {
      finish({ state: 'failed', reason: 'The sign-in was not finished in time. Start it again.' });
      kill();
    }, options.limitMs ?? SIGN_IN_LIMIT_MS);
    const urlWait = setTimeout(() => nowKnown(), options.urlWaitMs ?? URL_WAIT_MS);
    // The child never outlives the server, however the server ends.
    process.once('exit', kill);
    child.stdout.on('data', heard);
    child.stderr.on('data', heard);
    child.stdin.on('error', () => undefined); // it ended before a code reached it
    child.on('error', (error) => finish({ state: 'failed', reason: `The sign-in could not be started: ${error.message}` }));
    child.on('close', (code) => finish(cancelled ? { state: 'idle' } : code === 0 ? { state: 'done' } : { state: 'failed', reason: signInFailure(output.slice(-TAIL_CHARS), code) }));
    return started;
  };

  return {
    async start() {
      if (!run) {
        const command = options.command();
        if (!command) return (last = { state: 'failed', reason: options.missing });
        run = begin(command);
      }
      const current = run;
      await current.known;
      return current.progress;
    },
    wait: () => run?.ended ?? Promise.resolve(last),
    code(text) {
      const code = text.trim().slice(0, MAX_CODE);
      if (code && !/[\r\n]/.test(code)) run?.code(code);
    },
    cancel: () => run?.cancel(),
  };
}
