// Which repository a linked worktree was cut from, read from its `.git` file without running git:
// the file says `gitdir: <repo>/.git/worktrees/<name>`. Used to resolve the directory of a session
// recorded before sessions remembered theirs (shared/project-folders.ts, `resolveStartedFolder`).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const GITDIR = /^gitdir:\s*(.+)$/m;
/** `<repo>/.git/worktrees/<name>` is three levels below the repository. */
const LEVELS_BELOW_REPO = 3;

/** The main checkout a worktree belongs to, as a real path, or null when that cannot be read. */
export function worktreeRepo(worktreePath: string): string | null {
  try {
    const marker = join(worktreePath, '.git');
    if (!existsSync(marker) || !statSync(marker).isFile()) return null;
    const found = GITDIR.exec(readFileSync(marker, 'utf8'));
    if (!found) return null;
    let repo = resolve(worktreePath, found[1]!.trim());
    for (let i = 0; i < LEVELS_BELOW_REPO; i++) repo = dirname(repo);
    return existsSync(repo) ? realpathSync(repo) : null;
  } catch {
    return null;
  }
}
