// One `codex app-server` child: started with the user's own Codex (found as binary.ts finds it),
// spoken to over stdio JSON-RPC (rpc.ts), its stderr kept as a short tail for the reason a crash
// gives. Every child is also killed when the Kestrel server process exits, however it exits.
import { spawn } from 'node:child_process';
import { hostPlatform } from '../../host.ts';
import { spawnTarget } from '../find-program.ts';
import { existsSync } from 'node:fs';
import { codexEnv, findCodex } from './binary.ts';
import { RpcConnection, type RpcHandlers } from './rpc.ts';

type Env = Record<string, string | undefined>;

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** The end of what it wrote to stderr, colour codes removed. */
  stderr: string;
}

export interface AppServer {
  rpc: RpcConnection;
  /** Ends the process (SIGTERM). Safe to call more than once. */
  kill(): void;
}

export interface LaunchOptions {
  env: Env;
  handlers: RpcHandlers;
  /** Called once when the process ends or could not start. */
  onExit(info: ExitInfo): void;
}

/** Starts an app-server. Throws `CodexUnavailable` when there is no Codex to start. */
export type Launch = (options: LaunchOptions) => AppServer;

/** Codex is not installed, or not signed in: a reason the user can act on. */
export class CodexUnavailable extends Error {
  constructor(
    message: string,
    readonly kind: 'missing' | 'auth',
  ) {
    super(message);
  }
}

export const NOT_INSTALLED =
  'Codex is not installed: Kestrel found no `codex` command on your PATH or in the usual install folders. Install the Codex CLI (`npm install -g @openai/codex`), run `codex login` in a terminal, then send again.';
export const NOT_SIGNED_IN = 'Codex is not signed in. Run `codex login` in a terminal (it uses your ChatGPT account or an API key), then send again.';

const TAIL_BYTES = 4000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Keeps the last few KB written to a stream. */
export class Tail {
  private text = '';
  push(chunk: string): void {
    this.text = (this.text + chunk.replace(ANSI, '')).slice(-TAIL_BYTES);
  }
  toString(): string {
    return this.text.trim();
  }
}

const alive = new Set<{ kill(): void }>();
let exitHookInstalled = false;
/** Children are killed when this process exits, even on a crash, so none outlives the server. */
function track(child: { kill(): void }): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => alive.forEach((c) => c.kill()));
  }
  alive.add(child);
  return () => alive.delete(child);
}

/** Which `codex` to run: `KESTREL_CODEX_BINARY` when set (tests and support), else the lookup. Null when there is none. */
export function codexBinary(env: Env = process.env): string | null {
  const override = env.KESTREL_CODEX_BINARY;
  if (override !== undefined && override !== '') return existsSafe(override) ? override : null;
  return findCodex(env);
}

const existsSafe = (path: string) => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

/** The environment the child gets: the server's own, minus Kestrel's launch token. */
export function childEnv(env: Env, binary: string, extra: Env): Env {
  const { KESTREL_TOKEN: _launchToken, ...rest } = env;
  return { ...codexEnv(rest, binary), ...extra };
}

/** Starts the user's `codex app-server`. */
export const launchCodex: Launch = ({ env, handlers, onExit }) => {
  const binary = codexBinary(env);
  if (!binary) throw new CodexUnavailable(NOT_INSTALLED, 'missing');
  return launchCommand(binary, ['app-server'], childEnv(env, binary, {}), handlers, onExit);
};

/** Starts any program that speaks the app-server protocol on stdio (the real one, or a test's fake). */
export function launchCommand(command: string, args: string[], env: Env, handlers: RpcHandlers, onExit: (info: ExitInfo) => void): AppServer {
  const target = spawnTarget(command, hostPlatform());
  const child = spawn(target.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env as NodeJS.ProcessEnv, shell: target.shell, windowsHide: true });
  const tail = new Tail();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => tail.push(chunk));
  const rpc = new RpcConnection(child.stdout, child.stdin, handlers);
  const untrack = track({ kill: () => child.kill('SIGTERM') });
  let ended = false;
  const end = (code: number | null, signal: string | null, extra = '') => {
    if (ended) return;
    ended = true;
    untrack();
    rpc.close(code === null && signal ? `it was ended by ${signal}` : `it exited with code ${code}`);
    if (extra) tail.push(`\n${extra}`);
    onExit({ code, signal, stderr: tail.toString() });
  };
  child.on('error', (error) => end(null, null, error.message));
  child.on('exit', (code, signal) => end(code, signal));
  return {
    rpc,
    kill: () => {
      if (!ended && child.exitCode === null) child.kill('SIGTERM');
    },
  };
}
