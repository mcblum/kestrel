// The folders directly inside one folder, for adding several projects at once (shared/folder-batch.ts).
// Not recursive. Hidden (dot) folders and files are left out; symlinks are resolved to their real
// folder, so one pointing at a project's folder counts as that project. A git repository is a folder
// with `.git` at its top (no git process per folder); a folder inside the repository that holds the
// parent is not offered, as a single add would refuse it.
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { repoRoot } from './git.ts';
import type { Project } from './model.ts';
import { expandHome, projectWithFolder, realDirectory, uniqueProjectName } from './runtime/projects.ts';
import { PROJECT_BATCH_LIMITS, type FolderListing, type ListedFolder } from './shared/folder-batch.ts';
import { Refused } from './refused.ts';

/** Whether Kestrel may list and enter `path`. */
export function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The refusal for a folder Kestrel may not open. */
export const unreadableReason = (path: string): string => `Kestrel may not open ${path}: permission denied.`;

/** The folder asked for, as a real path, or a refusal saying what is wrong with it. */
function parentFolder(given: string): string {
  const asked = expandHome(given.trim());
  if (!isAbsolute(asked)) throw new Refused(`${given.trim() || 'That'} is not a full path. Give one like ~/Code or /Users/you/Code.`);
  const path = resolve(asked);
  if (!existsSync(path)) throw new Refused(`${path} is not a folder that exists.`);
  if (!statSync(path).isDirectory()) throw new Refused(`${path} is a file, not a folder.`);
  if (!isReadable(path)) throw new Refused(unreadableReason(path));
  return realDirectory(path)!;
}

/** The real folder an entry names: a directory, or a symlink to one; null for anything else. */
function entryFolder(parent: string, entry: Dirent): string | null {
  if (entry.isDirectory()) return join(parent, entry.name);
  return entry.isSymbolicLink() ? realDirectory(join(parent, entry.name)) : null;
}

type Found = { name: string; path: string };

/** The subfolders of `parent`, hidden ones left out, sorted by name. */
function subfolders(parent: string): Found[] {
  const entries = readdirSync(parent, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  const found = entries.flatMap((e) => {
    const path = entryFolder(parent, e);
    return path ? [{ name: e.name, path: realDirectory(path) ?? path }] : [];
  });
  const sorted = found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  // A symlink beside the folder it points at is the same folder: listed once, by the first name.
  const seen = new Set<string>();
  return sorted.filter((f) => !seen.has(f.path) && Boolean(seen.add(f.path)));
}

/** Where a linked worktree's `.git` file points, inside its main checkout: `<main>/.git/worktrees/<name>`. */
const WORKTREE_MARK = `${sep}.git${sep}worktrees${sep}`;
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;

/**
 * The main checkout a linked worktree belongs to, or null. A linked worktree has a `.git` FILE
 * naming a folder under the main checkout's `.git/worktrees`; no git process is run. A submodule's
 * `.git` file points under `.git/modules` and is not one.
 */
export function mainCheckoutOf(path: string): string | null {
  try {
    const dotGit = join(path, '.git');
    if (!statSync(dotGit).isFile()) return null;
    const named = GITDIR_LINE.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!named) return null;
    const gitDir = resolve(path, named);
    const at = gitDir.lastIndexOf(WORKTREE_MARK);
    if (at <= 0) return null;
    const main = gitDir.slice(0, at);
    return realDirectory(main) ?? main;
  } catch {
    // Not readable, or gone since it was listed: it is simply not marked.
    return null;
  }
}

/** A linked worktree's main checkout as the page shows it, with the project that has it. */
function worktreeOf(path: string, projects: readonly Project[]): ListedFolder['worktreeOf'] {
  const main = mainCheckoutOf(path);
  if (!main || main === path) return null;
  const holder = projectWithFolder(projects, main);
  return { path: main, name: basename(main), project: holder ? { id: holder.id, name: holder.name } : null };
}

/** What the page shows of one subfolder. `outerRepo` is the repository holding the parent, if any. */
function describe(found: Found, projects: readonly Project[], outerRepo: string | null): ListedFolder {
  const readable = isReadable(found.path);
  const isGit = readable && existsSync(join(found.path, '.git'));
  const holder = projectWithFolder(projects, found.path);
  const problem = outerRepo && !isGit ? `It is inside the git repository ${outerRepo}. Add ${outerRepo} itself instead.` : null;
  const addable = readable && !holder && !problem;
  return {
    name: found.name,
    path: found.path,
    isGit,
    readable,
    project: holder ? { id: holder.id, name: holder.name } : null,
    problem,
    proposedName: addable ? uniqueProjectName(basename(found.path), found.path, projects) : null,
    worktreeOf: isGit ? worktreeOf(found.path, projects) : null,
  };
}

/** The folders directly inside `given`, at most `PROJECT_BATCH_LIMITS.maxListed`. Refuses a path that is not a readable folder. */
export async function listFolder(given: string, projects: readonly Project[]): Promise<FolderListing> {
  const parent = parentFolder(given);
  const all = subfolders(parent);
  const outerRepo = await repoRoot(parent);
  const shown = all.slice(0, PROJECT_BATCH_LIMITS.maxListed);
  return { parent, folders: shown.map((f) => describe(f, projects, outerRepo)), total: all.length, truncated: all.length > shown.length };
}
