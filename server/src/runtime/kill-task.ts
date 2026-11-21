// Ending a background command's processes directly, when its agent cannot: Claude's CLI did not
// answer `stop_task` while it was quiet on background work (docs/spike-results.md, 2026-11-17), and
// a resumed CLI does not know a task an earlier process started. A background command writes its
// output to its own file (`tasks/<task id>.output`, runtime/task-output-file.ts), and every process
// it started holds that file open, so the processes holding it (and their descendants) are the
// command. Never ended: Kestrel itself and its ancestors, and any agent CLI process (`claude`),
// which may hold the file to read it. Asked with the system's own `lsof` and `ps`.
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { isTaskOutputPath } from './task-output-file.ts';

export interface Proc {
  pid: number;
  ppid: number;
  /** The executable, as `ps -o comm=` gives it (a path on macOS). */
  comm: string;
}

/** What killing needs from the system; the real one is `systemProcesses`, tests pass their own. */
export interface ProcessSystem {
  /** Processes with `path` open. */
  holders(path: string): Promise<number[]>;
  /** Every process. */
  table(): Promise<Proc[]>;
  /** Send `signal`; false when the process is gone. */
  signal(pid: number, signal: NodeJS.Signals): boolean;
  alive(pid: number): boolean;
  /** Kestrel's own process id. */
  self: number;
  sleep(ms: number): Promise<void>;
}

/** How long processes get to end after SIGTERM before SIGKILL, and how often they are checked. */
export const TERM_GRACE_MS = 2000;
export const POLL_MS = 100;

/** An agent's own CLI: never ended from here (it may hold the file to read it). */
const AGENT_EXECUTABLES = new Set(['claude', 'codex', 'opencode']);
const isAgent = (p: Proc): boolean => AGENT_EXECUTABLES.has(basename(p.comm));

/** `pid` and every process above it. Pure. */
export function ancestors(pid: number, table: readonly Proc[]): Set<number> {
  const parent = new Map(table.map((p) => [p.pid, p.ppid]));
  const out = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 0 && !out.has(at); at = parent.get(at)) out.add(at);
  return out;
}

/** The processes that are the command: the holders, less the protected and agents, with all their descendants. Pure. */
export function commandProcesses(holders: readonly number[], table: readonly Proc[], self: number): number[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const kept = ancestors(self, table);
  const allowed = (pid: number) => !kept.has(pid) && !(byPid.get(pid) && isAgent(byPid.get(pid)!));
  const out: number[] = [];
  const walk = (pid: number) => {
    if (out.includes(pid) || !allowed(pid)) return;
    out.push(pid);
    for (const child of table) if (child.ppid === pid) walk(child.pid);
  };
  for (const pid of holders) walk(pid);
  return out;
}

/**
 * Which processes were ended, and which of them only by SIGKILL. A process killed with SIGKILL may
 * still show for a moment as a zombie until its parent (the agent's CLI) reaps it, so it is not
 * waited for: SIGKILL cannot be caught.
 */
export interface KillResult {
  ended: number[];
  forced: number[];
}

async function waitGone(pids: readonly number[], sys: ProcessSystem): Promise<number[]> {
  for (let waited = 0; waited < TERM_GRACE_MS; waited += POLL_MS) {
    if (!pids.some((pid) => sys.alive(pid))) return [];
    await sys.sleep(POLL_MS);
  }
  return pids.filter((pid) => sys.alive(pid));
}

/** End the command writing to `outputFile`: SIGTERM, then SIGKILL for what is left after the grace. */
export async function killTaskProcesses(outputFile: string, sys: ProcessSystem): Promise<KillResult> {
  if (!isTaskOutputPath(outputFile)) return { ended: [], forced: [] };
  const holders = await sys.holders(outputFile);
  if (holders.length === 0) return { ended: [], forced: [] };
  const pids = commandProcesses(holders, await sys.table(), sys.self);
  const signalled = pids.filter((pid) => sys.signal(pid, 'SIGTERM'));
  const stubborn = await waitGone(signalled, sys);
  const forced = stubborn.filter((pid) => sys.signal(pid, 'SIGKILL'));
  return { ended: signalled, forced };
}

function run(file: string, args: readonly string[]): Promise<string> {
  // lsof exits 1 when nothing holds the file: that is an empty answer, not a failure.
  return new Promise((resolve, reject) => execFile(file, [...args], (error, stdout) => (error && !stdout && (error as { code?: unknown }).code !== 1 ? reject(error) : resolve(stdout))));
}

const numbers = (text: string): number[] => text.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);

/** This Mac's processes, through `/usr/sbin/lsof` and `/bin/ps`. */
export const systemProcesses: ProcessSystem = {
  holders: async (path) => numbers(await run('/usr/sbin/lsof', ['-t', '--', path])),
  table: async () =>
    (await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='])).split('\n').flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]!.trim() }] : [];
    }),
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  self: process.pid,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
