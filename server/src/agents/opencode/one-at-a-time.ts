// OpenCode programs start one at a time per OpenCode data folder. Every OpenCode program creates and migrates its own
// database (`opencode.db` in its data folder) as it starts, and two of them starting against a fresh database at once
// fail together ("DrizzleError: Failed to run the query 'CREATE TABLE …'"; found live on a worker node, 2026-11-27, with
// the node's own `opencode serve` starting while `kestrel node agents` ran `opencode auth list`). So every OpenCode
// program Kestrel runs goes through `startOpencode`: the adapter's `opencode serve` (each session's and each probe's)
// until it says it is listening, and each program of the node's checklist until it ends. Once a program is past its
// start the database exists and further programs open it as OpenCode itself allows.
//
// The gate holds across processes (the node's server and the `kestrel-node` terminal are two): a lock file in Kestrel's
// own folder (never in OpenCode's), one per OpenCode data folder, made with O_EXCL and holding the holder's process id.
// A lock whose process is gone, or that is older than `LOCK_STALE_MS`, is taken over. Without Kestrel's folder (a test's
// adapter) the gate holds within this process only.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/**
 * OpenCode's data folder, where its database is: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` (OpenCode
 * 1.14 uses the XDG folders on every platform). The one place Kestrel names it.
 */
export function opencodeDataFolder(env: Env, home: string = env.HOME || homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
}

/** OpenCode's own database, in its data folder. */
export const opencodeDatabase = (env: Env, home?: string): string => join(opencodeDataFolder(env, home), 'opencode.db');

/** Where Kestrel keeps these locks, in its own folder: the server and the node's terminal name it the same way. */
export const opencodeLocks = (dataDir: string): string => join(dataDir, 'locks');

/** A lock older than this is someone's crash: the longest a holder holds is a checklist's check turn (2 minutes). */
export const LOCK_STALE_MS = 5 * 60_000;
/** How long a start waits for another to be past its start before it gives up waiting and says so. */
export const LOCK_WAIT_MS = 3 * 60_000;
const POLL_MS = 100;

export class OpencodeBusy extends Error {}

export interface StartGate {
  /** Runs `work` (which starts an OpenCode program and resolves once it is past its start) alone for `env`'s data folder. */
  run<T>(env: Env, work: () => Promise<T>): Promise<T>;
}

export interface GateOptions {
  now?: () => number;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The one gate: in Kestrel's folder `lockDir` across processes, or within this process when it is null. */
export function startGate(lockDir: string | null, options: GateOptions = {}): StartGate {
  const now = options.now ?? Date.now;
  const alive = options.alive ?? isAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const inProcess = new Map<string, Promise<unknown>>();

  const lockPath = (folder: string): string => join(lockDir!, `opencode-${createHash('sha256').update(folder).digest('hex').slice(0, 16)}.lock`);

  /** Takes the lock file, or says it is someone else's. */
  const tryTake = (path: string): boolean => {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = NaN;
    let age = 0;
    try {
      holder = Number(readFileSync(path, 'utf8').trim());
      age = now() - statSync(path).mtimeMs;
    } catch {
      return false; // Released between the two looks: try again.
    }
    if (Number.isInteger(holder) && holder > 0 && alive(holder) && age < LOCK_STALE_MS) return false;
    try {
      unlinkSync(path);
    } catch {
      // Someone else took it over first.
    }
    return false;
  };

  const acrossProcesses = async <T>(folder: string, work: () => Promise<T>): Promise<T> => {
    mkdirSync(lockDir!, { recursive: true, mode: 0o700 });
    const path = lockPath(folder);
    const started = now();
    while (!tryTake(path)) {
      if (now() - started > waitMs) throw new OpencodeBusy(`Another OpenCode program was still starting after ${Math.round(waitMs / 1000)} seconds, so this one did not start. Try again in a moment.`);
      await sleep(POLL_MS);
    }
    try {
      return await work();
    } finally {
      try {
        unlinkSync(path);
      } catch {
        // Already taken over as stale.
      }
    }
  };

  return {
    run(env, work) {
      const folder = opencodeDataFolder(env);
      // Within this process callers queue; across processes the lock file decides.
      const before = inProcess.get(folder) ?? Promise.resolve();
      const mine = before.catch(() => undefined).then(() => (lockDir ? acrossProcesses(folder, work) : work()));
      const tail = mine.catch(() => undefined);
      inProcess.set(folder, tail);
      void tail.then(() => inProcess.get(folder) === tail && inProcess.delete(folder));
      return mine;
    },
  };
}
