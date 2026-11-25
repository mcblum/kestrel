// What the inventory readers may do to the machine: read a few files, list folders, and ask a program
// a question. Nothing here writes. A reader never opens a credential store: not the Keychain, not
// `~/.codex/auth.json`, not `gh`'s or `glab`'s token, not an SSH private key, not a `.env` file. The
// leak test (setup-record.test.ts) swaps these for ones that note every path read.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A file larger than this is not read to be checked; it is listed and said to be too big. */
export const READ_MAX_BYTES = 512 * 1024;
/** How long one question to a program may take. */
export const RUN_TIMEOUT_MS = 5000;

export interface FsRead {
  /** A file's text, or null when it is missing, unreadable or too big. */
  text(path: string): string | null;
  /** A folder's entries, or empty. */
  list(dir: string): { name: string; dir: boolean }[];
  exists(path: string): boolean;
}

export const nodeFs: FsRead = {
  text(path) {
    try {
      if (statSync(path).size > READ_MAX_BYTES) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => {
        let isDir = d.isDirectory();
        // A link is followed once, to say whether it is a folder.
        if (d.isSymbolicLink()) {
          try {
            isDir = statSync(join(dir, d.name)).isDirectory();
          } catch {
            isDir = false;
          }
        }
        return { name: d.name, dir: isDir };
      });
    } catch {
      return [];
    }
  },
  exists: existsSync,
};

/** A program's answer: what it printed and how it ended; null when it could not be started (not installed). */
export type RunAnswer = { stdout: string; stderr: string; code: number | null } | null;
export type Run = (file: string, args: readonly string[], cwd?: string) => Promise<RunAnswer>;

export const nodeRun: Run = (file, args, cwd) =>
  new Promise((resolve) =>
    execFile(file, [...args], { cwd, timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return resolve(null);
      resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : 1) : 0 });
    }),
  );
