// Which repositories a project is, as every computer of the account names them: the remotes of each of
// its git folders as repository keys (shared/knowledge.ts `repositoryKey`), `origin` first. Two computers'
// clones of one repository share a key, which a local project id never would (account-sessions.md, section
// 10.1); every remote counts, so a clone made from a mirror is the same project as one made from the other.
// Read from git and kept a while: a remote rarely changes, and this is asked on every change.
import { remoteUrls } from './git.ts';
import type { Project } from './model.ts';
import { repositoryKey } from './shared/knowledge.ts';

const KEPT_MS = 10 * 60 * 1000;

export class RepoKeys {
  private readonly known = new Map<string, { keys: Promise<string[]>; at: number }>();

  constructor(
    private readonly remotes: (path: string) => Promise<string[]> = remoteUrls,
    private readonly now: () => number = Date.now,
  ) {}

  /** A folder's repository keys, `origin`'s first; none when it has no remote or git cannot say. */
  ofFolder(path: string): Promise<string[]> {
    const kept = this.known.get(path);
    if (kept && this.now() - kept.at < KEPT_MS) return kept.keys;
    const keys = this.remotes(path).then(
      (urls) => urls.flatMap((url) => repositoryKey(url) ?? []),
      () => [],
    );
    this.known.set(path, { keys, at: this.now() });
    return keys;
  }

  /** The project's repository keys, in the order of its folders; none for a plain folder or a repository with no remote. */
  async ofProject(project: Project): Promise<string[]> {
    const keys = await Promise.all(project.folders.filter((f) => f.isGit).map((f) => this.ofFolder(f.path)));
    return [...new Set(keys.flat())];
  }
}
