// The environment settings (shared/project-env.ts) turned into what a session gets: the variables
// for its agent and its scripts, and the untracked files copied into its new worktree. Neither
// throws: what could not be read or copied comes back in words, for the session to be told.
import { cp, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { git } from '../git.ts';
import { parseVars, scopesFor, usableVars, type EnvByScope } from '../shared/project-env.ts';

/** At most this many files are copied into one worktree: a pattern that matches more was a mistake. */
export const MAX_COPIED_FILES = 500;

const located = (file: string, root: string | null, home: string): string | null => (file.startsWith('~/') ? join(home, file.slice(2)) : isAbsolute(file) ? file : root ? resolve(root, file) : null);

export interface ResolvedEnv {
  env: Record<string, string>;
  problems: string[];
}

/**
 * The variables for a session in `projectId` (null: no project), whose project folder is `root`.
 * Later wins: the app-wide .env files, the app-wide variables, the project's .env files, the
 * project's variables.
 */
export async function resolveEnv(all: EnvByScope, projectId: string | null, root: string | null, home = homedir()): Promise<ResolvedEnv> {
  const problems: string[] = [];
  let env: Record<string, string> = {};
  for (const scope of scopesFor(all, projectId)) {
    for (const file of scope.files) {
      const path = located(file, root, home);
      if (!path) {
        problems.push(`The .env file ${file} is relative to a project's folder, and this session has no project.`);
        continue;
      }
      try {
        env = { ...env, ...usableVars(parseEnv(await readFile(path, 'utf8'))) };
      } catch (error) {
        problems.push(`The .env file ${file} could not be read: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'it does not exist' : error instanceof Error ? error.message : String(error)}.`);
      }
    }
    env = { ...env, ...parseVars(scope.vars).vars };
  }
  return { env, problems };
}

export interface Copied {
  /** Paths copied, relative to the worktree. */
  copied: string[];
  problems: string[];
}

/**
 * Copies the files the patterns name from the project's folder into a new worktree: only files
 * git does not track there (tracked ones are in the worktree already), and never over a file the
 * worktree has.
 */
export async function copyIntoWorktree(all: EnvByScope, projectId: string, root: string, worktree: string): Promise<Copied> {
  const patterns = [...new Set(scopesFor(all, projectId).flatMap((s) => s.copy))];
  if (patterns.length === 0) return { copied: [], problems: [] };
  const problems: string[] = [];
  let listed: string[];
  try {
    // Untracked and ignored files matching the patterns, as git reads a pattern (`*` does not cross a `/`, `**` does).
    listed = (await git(root, ['ls-files', '--others', '-z', '--', ...patterns.map((p) => `:(glob)${p}`)])).split('\0').filter(Boolean);
  } catch (error) {
    return { copied: [], problems: [`The files to copy could not be listed: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (listed.length > MAX_COPIED_FILES) {
    problems.push(`The files to copy match ${listed.length} files; only the first ${MAX_COPIED_FILES} were copied. Narrow the patterns in the project's Settings under Environment.`);
    listed = listed.slice(0, MAX_COPIED_FILES);
  }
  const copied: string[] = [];
  for (const file of listed) {
    const to = join(worktree, file);
    if (existsSync(to)) continue;
    try {
      await mkdir(dirname(to), { recursive: true });
      await cp(join(root, file), to, { verbatimSymlinks: true, errorOnExist: false, force: false });
      copied.push(file);
    } catch (error) {
      problems.push(`${file} could not be copied: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { copied, problems };
}

const SHOWN = 5;

/** What the session is told was copied; null when nothing was. */
export function copiedNotice(copied: readonly string[]): string | null {
  if (copied.length === 0) return null;
  const names = copied.slice(0, SHOWN).join(', ');
  return `Copied ${copied.length === 1 ? '1 file' : `${copied.length} files`} from the project's folder into this worktree: ${names}${copied.length > SHOWN ? ` and ${copied.length - SHOWN} more` : ''}.`;
}
