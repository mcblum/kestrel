// A project's Git defaults (0.0.20, matt/kestrel#16): which branch is its base and which remote
// that branch is fetched from, chosen for the project instead of read from whatever its checkout
// happens to be on. Empty means automatic: the remote `origin`, and the branch its HEAD names,
// else main, else master (start-base/check.ts). Pure and browser-safe: the rules and the words.

export interface GitDefaults {
  /** The base branch new sessions start from and pull requests target; '' for the remote's own default. */
  baseBranch: string;
  /** The remote the base branch is fetched from; '' for `origin`. */
  remote: string;
}

/** Every project's defaults, by project id; a project with nothing chosen is absent. */
export type GitDefaultsByProject = Readonly<Record<string, GitDefaults>>;

export const AUTOMATIC: GitDefaults = { baseBranch: '', remote: '' };
export const DEFAULT_REMOTE = 'origin';
const MAX_NAME = 200;

/** Why git would not take `name` as a branch or remote name, or null when it would ('' is automatic). */
export function gitNameProblem(name: string, what: 'branch' | 'remote'): string | null {
  if (!name) return null;
  const label = what === 'branch' ? 'A branch name' : 'A remote name';
  if (name.length > MAX_NAME) return `${label} can be at most ${MAX_NAME} characters.`;
  if (name.startsWith('-')) return `${label} cannot start with "-".`;
  // What git-check-ref-format refuses: spaces and control characters, ~ ^ : ? * [ \, "..", "@{", a leading or trailing or doubled "/", a trailing "." or ".lock".
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) || name.includes('..') || name.includes('@{') || name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.endsWith('.') || name.endsWith('.lock')) return `"${name}" is not a name git accepts for a ${what}.`;
  if (what === 'remote' && name.includes('/')) return 'A remote name cannot contain "/".';
  return null;
}

/** Why these defaults cannot be saved, or null when they can. `value` is what a client sent. */
export function gitDefaultsProblem(value: unknown): string | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.baseBranch !== 'string' || typeof v.remote !== 'string') return 'Send baseBranch and remote as text; empty for automatic.';
  return gitNameProblem(v.baseBranch.trim(), 'branch') ?? gitNameProblem(v.remote.trim(), 'remote');
}

export function sanitizeGitDefaults(value: unknown): GitDefaults {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const name = (raw: unknown, what: 'branch' | 'remote'): string => (typeof raw === 'string' && gitNameProblem(raw.trim(), what) === null ? raw.trim() : '');
  return { baseBranch: name(v.baseBranch, 'branch'), remote: name(v.remote, 'remote') };
}

export const hasGitDefaults = (defaults: GitDefaults): boolean => Boolean(defaults.baseBranch || defaults.remote);

export function sanitizeGitDefaultsByProject(value: unknown): GitDefaultsByProject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, GitDefaults> = {};
  for (const [projectId, raw] of Object.entries(value)) {
    const defaults = sanitizeGitDefaults(raw);
    if (projectId.length > 0 && projectId.length <= 200 && hasGitDefaults(defaults)) out[projectId] = defaults;
  }
  return out;
}

/** `all` with the project's defaults replaced; a project back on automatic is dropped. */
export function withGitDefaults(all: GitDefaultsByProject, projectId: string, defaults: GitDefaults): GitDefaultsByProject {
  const { [projectId]: _old, ...rest } = all;
  return hasGitDefaults(defaults) ? { ...rest, [projectId]: defaults } : rest;
}

/** What a repository offers to choose from, and what automatic comes to there. */
export interface GitChoices {
  remotes: string[];
  /** Branch names, local ones and the chosen remote's, without the remote's prefix. */
  branches: string[];
  /** The base branch automatic finds with the chosen remote; null when there is none. */
  automaticBranch: string | null;
}

/** What a session is told when the project's chosen base branch is not there to start from. */
export const missingBaseNotice = (branch: string, remote: string): string => `This project's base branch is set to ${branch}, but there is no ${branch} on ${remote} or locally. Started from the checkout as it is. Change it on the project's Settings tab under Git.`;
