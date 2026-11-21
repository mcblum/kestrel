// What a project's checkout is on, compared with its default branch: the facts the New session box
// asks about (shared/start-base.ts). Local git only, no fetch, so the answer comes at once; the
// fetch happens after the choice, while the session starts (base-refresh.ts).
import { currentBranch, git } from '../git.ts';
import { AUTOMATIC, DEFAULT_REMOTE, type GitDefaults } from '../shared/git-defaults.ts';

/** The repository's default branch and the ref to compare with: `origin/HEAD`'s branch, else main or master. Null when there is none. */
export interface DefaultBranch {
  name: string;
  /** `refs/remotes/origin/<name>` when it is known, else `refs/heads/<name>`. */
  ref: string;
}

export interface CheckoutState {
  branch: string | null;
  defaultBranch: string;
  ahead: number;
  behind: number;
  contained: boolean;
  uncommitted: number;
}

const FALLBACK_DEFAULTS = ['main', 'master'] as const;

const ask = (repo: string, args: string[]): Promise<string> => git(repo, args, { allowFail: true }).then((out) => out.trim());
const exists = async (repo: string, ref: string): Promise<boolean> => (await ask(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== '';

/**
 * The project's base branch: the one chosen for it (shared/git-defaults.ts), else its remote's HEAD,
 * else main or master. Null when the chosen one is nowhere, or there is no remote HEAD and no main
 * or master. Never throws.
 */
export async function defaultBranchOf(repo: string, defaults: GitDefaults = AUTOMATIC): Promise<DefaultBranch | null> {
  const remote = defaults.remote || DEFAULT_REMOTE;
  const remoteHead = defaults.baseBranch ? '' : await ask(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  const fromRemote = remoteHead.startsWith(`${remote}/`) ? remoteHead.slice(remote.length + 1) : '';
  for (const name of defaults.baseBranch ? [defaults.baseBranch] : fromRemote ? [fromRemote] : FALLBACK_DEFAULTS) {
    if (await exists(repo, `refs/remotes/${remote}/${name}`)) return { name, ref: `refs/remotes/${remote}/${name}` };
    if (await exists(repo, `refs/heads/${name}`)) return { name, ref: `refs/heads/${name}` };
  }
  return null;
}

/** Null when the checkout is on its default branch, there is no default branch, or there are no commits. Never throws. */
export async function checkoutState(repo: string, defaults: GitDefaults = AUTOMATIC): Promise<CheckoutState | null> {
  const [branch, found, head] = await Promise.all([currentBranch(repo), defaultBranchOf(repo, defaults), ask(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])]);
  if (!found || !head || branch === found.name) return null;
  const [counts, status] = await Promise.all([ask(repo, ['rev-list', '--left-right', '--count', `HEAD...${found.ref}`]), ask(repo, ['status', '--porcelain', '--untracked-files=normal'])]);
  const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number).map((n) => (Number.isInteger(n) ? n : 0));
  const uncommitted = status ? status.split('\n').filter(Boolean).length : 0;
  return { branch, defaultBranch: found.name, ahead, behind, contained: ahead === 0, uncommitted };
}
