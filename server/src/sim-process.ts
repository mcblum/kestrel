// How the simulator code runs other programs: one injectable runner for short commands
// (`xcrun simctl …`) and one spawner for the long-lived helper processes. Tests pass fakes.
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs a command to completion. Never rejects: a failure to start is code -1 with the reason in stderr. */
export type Runner = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<RunResult>;

/** A long-lived child as the simulator code uses it. */
export interface Child {
  write(line: string): void;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}
export type Spawner = (command: string, args: readonly string[]) => Child;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDERR = 8_000;

export const runCommand: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < MAX_STDERR) err += d.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? -1 : 0), stdout: Buffer.concat(out), stderr: signal === 'SIGKILL' && code === null ? `${err}\n(timed out)`.trim() : err.trim() });
    });
  });

export const spawnChild: Spawner = (command, args) => {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exits: ((code: number | null) => void)[] = [];
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const l of exits) l(code);
  };
  child.on('error', () => exit(-1));
  child.on('exit', (code) => exit(code));
  child.stdin.on('error', () => undefined); // a helper that died mid-write is reported by its exit
  return {
    write: (line) => {
      if (!exited && child.stdin.writable) child.stdin.write(line);
    },
    onStdout: (l) => void child.stdout.on('data', l),
    onStderr: (l) => void child.stderr.on('data', l),
    onExit: (l) => void exits.push(l),
    kill: () => {
      if (!exited) child.kill();
    },
  };
};

/** Splits a stream into lines; the listener gets each complete line. */
export function lineReader(listener: (line: string) => void): (chunk: Buffer) => void {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString();
    let at: number;
    while ((at = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (line) listener(line);
    }
  };
}
