// Which repository a linked worktree was cut from, read from its `.git` file without running git:
// the file says `gitdir: <repo>/.git/worktrees/<name>`. Used to resolve the directory of a session
// recorded before sessions remembered theirs (shared/project-folders.ts, `resolveStartedFolder`).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const GITDIR = /^gitdir:\s*(.+)$/m;
/** `<repo>/.git/worktrees/<name>` is three levels below the repository. */
const LEVELS_BELOW_REPO = 3;

/** The folder a linked worktree's `.git` file names (`<repo>/.git/worktrees/<name>`), unresolved; null when `.git` is not such a file. */
function worktreeGitDir(worktreePath: string): string | null {
  const marker = join(worktreePath, '.git');
  if (!existsSync(marker) || !statSync(marker).isFile()) return null;
  const found = GITDIR.exec(readFileSync(marker, 'utf8'));
  return found ? resolve(worktreePath, found[1]!.trim()) : null;
}

/** The main checkout a worktree belongs to, as a real path, or null when that cannot be read. */
export function worktreeRepo(worktreePath: string): string | null {
  try {
    let repo = worktreeGitDir(worktreePath);
    if (!repo) return null;
    for (let i = 0; i < LEVELS_BELOW_REPO; i++) repo = dirname(repo);
    return existsSync(repo) ? realpathSync(repo) : null;
  } catch {
    return null;
  }
}

/**
 * The folders git itself writes for the checkout in `directory`, as real paths: its own `.git`, or
 * for a linked worktree the repository's `.git` (objects, refs) and the worktree's own folder under
 * it (index, HEAD). None for a folder that is no checkout. Read without running git.
 */
export function gitFolders(directory: string): string[] {
  try {
    const own = join(directory, '.git');
    if (existsSync(own) && statSync(own).isDirectory()) return [realpathSync(own)];
    const gitDir = worktreeGitDir(directory);
    const repo = worktreeRepo(directory);
    if (!gitDir || !repo || !existsSync(gitDir)) return [];
    return [join(repo, '.git'), realpathSync(gitDir)];
  } catch {
    return [];
  }
}
