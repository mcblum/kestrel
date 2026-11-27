// What a set-up step may do to this computer: run a program from an argument list (never through a
// shell, unless the argument list itself is a fixed script of Kestrel's own, setup-install.ts), and read
// and write files under the home folder. Tests swap both for a fake runner and a temporary home folder.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnTarget } from '../agents/find-program.ts';
import type { Platform } from '../shared/platform.ts';

export interface RunOptions {
  cwd: string;
  /** Written to the program's standard input, then closed. Never kept. */
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Each piece of output as it comes. */
  output?(text: string): void;
}

export interface RunOutcome {
  /** The exit code; null when it was stopped (time limit) or could not start. */
  code: number | null;
  /** Why it did not run to an end: "not installed", "took longer than 10 minutes". */
  problem: string | null;
}

export type CommandRunner = (argv: readonly string[], options: RunOptions) => Promise<RunOutcome>;

/** The real runner: `spawn` with an argument list, standard input closed after `stdin`, and a time limit. */
export function nodeRunner(platform: Platform): CommandRunner {
  return (argv, options) =>
    new Promise((resolve) => {
      const [file, ...args] = argv;
      if (!file) return resolve({ code: null, problem: 'There was no command to run.' });
      const target = spawnTarget(file, platform);
      let settled = false;
      const done = (outcome: RunOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const child = spawn(target.command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: target.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        done({ code: null, problem: `It took longer than ${Math.round(options.timeoutMs / 60_000)} minutes and was stopped.` });
      }, options.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => options.output?.(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => options.output?.(chunk.toString('utf8')));
      child.on('error', (error: NodeJS.ErrnoException) => done({ code: null, problem: error.code === 'ENOENT' ? `${file} is not installed here.` : error.message }));
      child.on('close', (code) => done({ code, problem: null }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin ?? '');
    });
}

/** Files under the home folder: the only writes a step makes outside a program it runs. */
export interface SetupFs {
  read(path: string): string | null;
  exists(path: string): boolean;
  write(path: string, text: string, mode?: number): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  mkdir(path: string, mode?: number): void;
  /** A link's target, or null when it is not a link. */
  link(path: string): string | null;
  symlink(target: string, path: string): void;
  /** The path with every link resolved, for the parts that exist. */
  real(path: string): string;
}

export const nodeSetupFs: SetupFs = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: existsSync,
  write: (path, text, mode) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) chmodSync(path, mode);
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  rename: (from, to) => renameSync(from, to),
  mkdir: (path, mode) => void mkdirSync(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) }),
  link: (path) => {
    try {
      return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
    } catch {
      return null;
    }
  },
  symlink: (target, path) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  },
  real: (path) => {
    // Resolve the longest part that exists, then add the rest.
    let head = path;
    const rest: string[] = [];
    while (!existsSync(head) && dirname(head) !== head) {
      rest.unshift(head.slice(dirname(head).length + 1));
      head = dirname(head);
    }
    try {
      return [realpathSync(head), ...rest].join('/');
    } catch {
      return path;
    }
  },
};
