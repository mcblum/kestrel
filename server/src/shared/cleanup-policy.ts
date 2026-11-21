// What Kestrel does by itself when a session's pull request is merged (0.0.20, matt/kestrel#19):
// archive the session, remove its worktree, delete its local branch. Each is a switch, all off
// until turned on; one set applies to every project (`GLOBAL_POLICY`) and a project may have its
// own instead. Work that exists nowhere else is never removed: a worktree with uncommitted files
// stays, and so does a branch with commits that were never pushed. Pure and browser-safe.

export interface CleanupPolicy {
  /** Archive the session (out of the sidebar, brought back from Settings → Archived). */
  archive: boolean;
  /** Remove its worktree folder, when nothing in it is uncommitted. */
  removeWorktree: boolean;
  /** Delete its local branch, when every commit on it was pushed. Only with the worktree removed: a checked-out branch cannot be deleted. */
  deleteBranch: boolean;
}

/** The scope of the policy every project follows unless it has its own. */
export const GLOBAL_POLICY = '*';
/** The app-wide policy and each project's own, by `GLOBAL_POLICY` or project id; a project with none follows the app-wide one. */
export type PolicyByScope = Readonly<Record<string, CleanupPolicy>>;

export const NO_CLEANUP: CleanupPolicy = { archive: false, removeWorktree: false, deleteBranch: false };

export const POLICY_LABEL: Record<keyof CleanupPolicy, string> = {
  archive: 'Archive the session',
  removeWorktree: 'Remove its worktree',
  deleteBranch: 'Delete its local branch',
};

const flag = (value: unknown): boolean => value === true;

/** A policy as stored: the branch goes only with the worktree. */
export function sanitizePolicy(value: unknown): CleanupPolicy {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const removeWorktree = flag(v.removeWorktree);
  return { archive: flag(v.archive), removeWorktree, deleteBranch: removeWorktree && flag(v.deleteBranch) };
}

/** Why this cannot be a policy, or null when it can. `value` is what a client sent. */
export function policyProblem(value: unknown): string | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if ((['archive', 'removeWorktree', 'deleteBranch'] as const).some((key) => typeof v[key] !== 'boolean')) return 'Send archive, removeWorktree and deleteBranch as true or false.';
  return v.deleteBranch === true && v.removeWorktree !== true ? 'A branch is deleted only with its worktree removed: it cannot be deleted while it is checked out there.' : null;
}

export function sanitizePolicies(value: unknown): PolicyByScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, CleanupPolicy> = {};
  for (const [scope, raw] of Object.entries(value)) if (scope.length > 0 && scope.length <= 200 && typeof raw === 'object' && raw !== null) out[scope] = sanitizePolicy(raw);
  return out;
}

/** `all` with one scope's policy set, or (null) removed: a project then follows the app-wide one again. */
export function withPolicy(all: PolicyByScope, scope: string, policy: CleanupPolicy | null): PolicyByScope {
  const { [scope]: _old, ...rest } = all;
  return policy ? { ...rest, [scope]: policy } : rest;
}

/** The policy a project's sessions follow: its own, else the app-wide one, else nothing. */
export const policyFor = (all: PolicyByScope, projectId: string | null): CleanupPolicy => (projectId ? all[projectId] : undefined) ?? all[GLOBAL_POLICY] ?? NO_CLEANUP;

export const cleansUp = (policy: CleanupPolicy): boolean => policy.archive || policy.removeWorktree;

/** What is known about a session whose pull request was just merged. */
export interface MergedFacts {
  /** Its agent is working or waiting on the user: it is left alone. */
  working: boolean;
  /** It has a worktree on disk. */
  hasWorktree: boolean;
  /** Files in the worktree that are not committed. */
  uncommitted: number;
  /** Commits on its branch that are on no remote. */
  unpushed: number;
}

/** What to do, and what was left and why, in the user's words. */
export interface CleanupPlan {
  archive: boolean;
  removeWorktree: boolean;
  deleteBranch: boolean;
  kept: string[];
}

const NOTHING: CleanupPlan = { archive: false, removeWorktree: false, deleteBranch: false, kept: [] };
const files = (n: number): string => (n === 1 ? '1 file' : `${n} files`);
const commits = (n: number): string => (n === 1 ? '1 commit' : `${n} commits`);

/** The rule: what the policy asks for, less what would lose work. */
export function cleanupPlan(policy: CleanupPolicy, facts: MergedFacts): CleanupPlan {
  if (!cleansUp(policy) || facts.working) return NOTHING;
  const kept: string[] = [];
  const wantsWorktree = policy.removeWorktree && facts.hasWorktree;
  const removeWorktree = wantsWorktree && facts.uncommitted === 0;
  if (wantsWorktree && !removeWorktree) kept.push(`Its worktree was kept: ${files(facts.uncommitted)} in it ${facts.uncommitted === 1 ? 'is' : 'are'} not committed.`);
  const deleteBranch = removeWorktree && policy.deleteBranch && facts.unpushed === 0;
  if (removeWorktree && policy.deleteBranch && !deleteBranch) kept.push(`Its branch was kept: ${commits(facts.unpushed)} on it ${facts.unpushed === 1 ? 'was' : 'were'} never pushed.`);
  return { archive: policy.archive, removeWorktree, deleteBranch, kept };
}

/** The line the session gets; null when nothing was done and nothing kept. */
export function mergedNotice(plan: CleanupPlan, archiveProblem: string | null = null): string | null {
  const did = [plan.archive && !archiveProblem ? 'archived this session' : '', plan.removeWorktree ? 'removed its worktree' : '', plan.deleteBranch ? 'deleted its local branch' : ''].filter(Boolean);
  const kept = archiveProblem ? [archiveProblem, ...plan.kept] : plan.kept;
  if (did.length === 0 && kept.length === 0) return null;
  const list = did.length > 1 ? `${did.slice(0, -1).join(', ')} and ${did.at(-1)}` : did[0];
  return [did.length > 0 ? `Its pull request was merged, so Kestrel ${list}.` : 'Its pull request was merged.', ...kept].join(' ');
}
