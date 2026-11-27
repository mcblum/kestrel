// One `opencode serve` child per Kestrel session (and a short-lived one for each probe): the
// user's own OpenCode, started with a per-process configuration (OPENCODE_CONFIG_CONTENT, which
// OpenCode merges over the user's files without writing them) and a random password, so only
// Kestrel can talk to it although it listens on a loopback port. It prints
// "opencode server listening on http://127.0.0.1:<port>" once it is ready (opencode 1.14.25).
// Every child is killed when the Kestrel server process exits, however it exits.
import { spawn } from 'node:child_process';
import { hostPlatform } from '../../host.ts';
import { spawnTarget } from '../find-program.ts';
import { randomBytes } from 'node:crypto';
import { dirname, delimiter } from 'node:path';
import { Tail } from '../codex/process.ts';
import { findOpencode } from './binary.ts';
import { startGate, type StartGate } from './one-at-a-time.ts';

type Env = Record<string, string | undefined>;

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** The end of what it wrote to stdout and stderr, colour codes removed. */
  output: string;
}

export interface OpencodeServer {
  /** Where it listens, e.g. http://127.0.0.1:52011. */
  url: string;
  /** The Basic credentials every request must carry. */
  authorization: string;
  /** Ends the process (SIGTERM). Safe to call more than once. */
  kill(): void;
}

export interface LaunchOptions {
  env: Env;
  /** OpenCode's configuration for this process only, as OPENCODE_CONFIG_CONTENT. */
  config: Record<string, unknown>;
  /** Run without the user's plugins (`--pure`): a session that does not load the user's setup. */
  pure: boolean;
  /** Called once when the process ends after it was ready. */
  onExit(info: ExitInfo): void;
}

/** Starts a server and resolves once it listens. Rejects with `OpencodeUnavailable` when there is no OpenCode, or with what it printed when it would not start. */
export type Launch = (options: LaunchOptions) => Promise<OpencodeServer>;

/** OpenCode is not installed, or has nothing to run a model with: a reason the user can act on. */
export class OpencodeUnavailable extends Error {
  constructor(
    message: string,
    readonly kind: 'missing' | 'auth',
  ) {
    super(message);
  }
}

export const NOT_INSTALLED =
  'OpenCode is not installed: Kestrel found no `opencode` command on your PATH or in the usual install folders. Install OpenCode (`curl -fsSL https://opencode.ai/install | bash`, or `brew install opencode`), run `opencode auth login` in a terminal to sign in to a model provider, then send again.';
export const NOT_SIGNED_IN = 'OpenCode has no model provider it can use. Run `opencode auth login` in a terminal to sign in to one, then send again.';

/** How long a server may take to say it is listening. */
export const READY_TIMEOUT_MS = 30_000;
const READY_LINE = /opencode server listening on (https?:\/\/\S+)/;
/** The user name OpenCode's server expects with OPENCODE_SERVER_PASSWORD. */
const SERVER_USER = 'opencode';

const alive = new Set<() => void>();
let exitHookInstalled = false;
function track(kill: () => void): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => alive.forEach((k) => k()));
  }
  alive.add(kill);
  return () => alive.delete(kill);
}

/**
 * The environment the child gets: the server's own minus Kestrel's launch token, OpenCode's
 * folder first on PATH, the configuration and password, and OpenCode's self-update switched off
 * (Kestrel never changes the user's installation).
 */
export function childEnv(env: Env, binary: string, config: Record<string, unknown>, password: string): Env {
  const { KESTREL_TOKEN: _launchToken, OPENCODE_CONFIG_CONTENT: _theirs, ...rest } = env;
  const path = [dirname(binary), ...(rest.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter);
  return { ...rest, PATH: path, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: '1' };
}

export const serveArgs = (pure: boolean): string[] => ['serve', '--hostname=127.0.0.1', '--port=0', ...(pure ? ['--pure'] : [])];

/** Starts any program that behaves like `opencode serve` (the real one, or a test's fake run by `command args…`). */
export function launchCommand(command: string, args: readonly string[], options: LaunchOptions & { binaryDir?: string }): Promise<OpencodeServer> {
  const password = randomBytes(24).toString('base64url');
  const env = childEnv(options.env, options.binaryDir ?? command, options.config, password);
  const target = spawnTarget(command, hostPlatform());
  const child = spawn(target.command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: env as NodeJS.ProcessEnv, shell: target.shell, windowsHide: true });
  const tail = new Tail();
  const untrack = track(() => child.kill('SIGTERM'));
  return new Promise((resolve, reject) => {
    let ready = false;
    let seen = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`OpenCode did not start within ${READY_TIMEOUT_MS / 1000} seconds.${tail.toString() ? `\n\nIts last output:\n${tail.toString()}` : ''}`));
    }, READY_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      tail.push(chunk);
      if (ready) return;
      seen += chunk;
      const match = READY_LINE.exec(seen);
      if (!match) return;
      ready = true;
      clearTimeout(timer);
      const authorization = `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString('base64')}`;
      resolve({ url: match[1]!, authorization, kill: () => child.exitCode === null && child.kill('SIGTERM') });
    });
    child.stderr.on('data', (chunk: string) => tail.push(chunk));
    const end = (code: number | null, signal: string | null, extra = '') => {
      untrack();
      clearTimeout(timer);
      if (extra) tail.push(`\n${extra}`);
      if (ready) return options.onExit({ code, signal, output: tail.toString() });
      ready = true;
      reject(new Error(`OpenCode stopped while starting (${signal ?? `exit code ${code}`}).${tail.toString() ? `\n\nIts last output:\n${tail.toString()}` : ''}`));
    };
    child.on('error', (error) => end(null, null, error.message));
    child.on('exit', (code, signal) => end(code, signal));
  });
}

/**
 * Starts the user's `opencode serve`, through the gate that lets one OpenCode program start at a time per data folder
 * (one-at-a-time.ts): it is held until the server says it is listening, so its database is made before the next starts.
 */
export function opencodeLauncher(gate: StartGate): Launch {
  return async (options) => {
    const binary = findOpencode(options.env);
    if (!binary) throw new OpencodeUnavailable(NOT_INSTALLED, 'missing');
    return gate.run(options.env, () => launchCommand(binary, serveArgs(options.pure), options));
  };
}

/** Starts the user's `opencode serve`, one at a time within this process (a test's or a tool's adapter). */
export const launchOpencode: Launch = opencodeLauncher(startGate(null));
