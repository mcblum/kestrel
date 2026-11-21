// What a session's Details pane shows beyond the session record: its branch against its base, the
// pull requests linked to that branch, and what its agent has cost. Types and small pure helpers,
// shared with the UI. The sources are on the server (git-status.ts, pull-requests/, usage.ts).
import { isHostKind, type HostKind } from './host-terms.ts';

/** The session's branch against the commit its worktree was cut from. */
export interface GitStatus {
  ahead: number;
  behind: number;
  /** Files in the worktree with changes that are not committed. */
  uncommitted: number;
  /** The full id of the commit the worktree is on; absent from sample data. */
  head?: string;
  /** What the base is called: the branch the worktree was cut from when known, else a short commit id. */
  baseLabel: string;
}

export type PullRequestState = 'draft' | 'open' | 'merged' | 'closed';
export type ChecksState = 'passing' | 'failing' | 'running' | 'none';
export type ReviewState = 'approved' | 'changes-requested' | 'review-required' | 'none';
/**
 * Whether the host would merge it now, in words both hosts map into: `ready` only on the host's own
 * affirmative answer; `unknown` when it has not worked it out (or said nothing).
 */
export type MergeReadiness = 'ready' | 'conflicts' | 'behind' | 'blocked' | 'unknown';

export interface PullRequest {
  number: number;
  title: string;
  state: PullRequestState;
  checks: ChecksState;
  review: ReviewState;
  url: string;
  checksUrl?: string;
  headSha?: string;
  body?: string;
  author?: string;
  headBranch?: string;
  baseBranch?: string;
  /** Absent means the host said nothing: the same as `unknown`. */
  readiness?: MergeReadiness;
}

/** The pull-requests route's answer: which kind of host answered (its words follow it), and what it found. */
export interface PullRequestLookup {
  host: HostKind;
  pullRequests: PullRequest[];
}

/** What a session's agent reported spending, summed over its turns. */
export interface SessionUsage {
  costUsd: number;
  turns: number;
}

/**
 * How many files a session's worktree has changed, for its sidebar row: `changed` counts what differs
 * from the base (committed, uncommitted and new: the files its Changes list), `uncommitted` what
 * `git status` lists (the same count as GitStatus).
 */
export interface ChangeCounts {
  changed: number;
  uncommitted: number;
  /** Lines added and removed across the session's changed files, as the session bar counts them. Absent from an older server. */
  added?: number;
  removed?: number;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

export const isChangeCounts = (v: unknown): v is ChangeCounts => {
  const c = v as ChangeCounts | null;
  return typeof c === 'object' && c !== null && isCount(c.changed) && isCount(c.uncommitted);
};

export const isGitStatus = (v: unknown): v is GitStatus => {
  const g = v as GitStatus | null;
  return typeof g === 'object' && g !== null && isCount(g.ahead) && isCount(g.behind) && isCount(g.uncommitted) && (g.head === undefined || typeof g.head === 'string') && typeof g.baseLabel === 'string';
};

const PR_STATES: readonly string[] = ['draft', 'open', 'merged', 'closed'];
const CHECKS: readonly string[] = ['passing', 'failing', 'running', 'none'];
const REVIEWS: readonly string[] = ['approved', 'changes-requested', 'review-required', 'none'];
const READINESS: readonly string[] = ['ready', 'conflicts', 'behind', 'blocked', 'unknown'];
const TEXT_FIELDS = ['body', 'author', 'headBranch', 'baseBranch', 'checksUrl', 'headSha'] as const;

export const isPullRequest = (v: unknown): v is PullRequest => {
  const p = v as PullRequest | null;
  return typeof p === 'object' && p !== null && isCount(p.number) && typeof p.title === 'string' && PR_STATES.includes(p.state) && CHECKS.includes(p.checks) && REVIEWS.includes(p.review) && typeof p.url === 'string' && (p.readiness === undefined || READINESS.includes(p.readiness)) && TEXT_FIELDS.every((key) => p[key] === undefined || typeof p[key] === 'string');
};

export const isPullRequestList = (v: unknown): v is PullRequest[] => Array.isArray(v) && v.every(isPullRequest);

/** The kind of host a lookup answer names, or null while there is none (loading, unavailable). */
export const lookupHost = (lookup: { state: string; value?: { host: HostKind } }): HostKind | null => (lookup.state === 'ready' && lookup.value ? lookup.value.host : null);

export const isPullRequestLookup = (v: unknown): v is PullRequestLookup => {
  const l = v as PullRequestLookup | null;
  return typeof l === 'object' && l !== null && isHostKind(l.host) && isPullRequestList(l.pullRequests);
};

export const isSessionUsage = (v: unknown): v is SessionUsage => {
  const u = v as SessionUsage | null;
  return typeof u === 'object' && u !== null && typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0 && isCount(u.turns);
};

/** A stored usage value as it is, or null when there is none or it is not one (an older store). */
export const readUsage = (v: unknown): SessionUsage | null => (isSessionUsage(v) ? v : null);

/**
 * Usage after one more finished turn. A turn whose agent reported no cost changes nothing: a
 * guess would be worse than "not recorded". Returns a new value; `before` is not changed.
 */
export function addTurnCost(before: SessionUsage | null, costUsd: number | undefined): SessionUsage | null {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return before;
  return { costUsd: (before?.costUsd ?? 0) + costUsd, turns: (before?.turns ?? 0) + 1 };
}

/** How the branch stands against its base, as one word. Behind and diverged are the ones that need attention. */
export type SyncState = 'up-to-date' | 'ahead' | 'behind' | 'diverged';

export function syncState(status: Pick<GitStatus, 'ahead' | 'behind'>): SyncState {
  if (status.ahead > 0 && status.behind > 0) return 'diverged';
  if (status.behind > 0) return 'behind';
  return status.ahead > 0 ? 'ahead' : 'up-to-date';
}

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** The state alone, without the base: "Up to date", "2 commits ahead", "1 commit behind", "Diverged · 2 ahead, 1 behind". */
export function syncText(status: Pick<GitStatus, 'ahead' | 'behind'>): string {
  switch (syncState(status)) {
    case 'up-to-date':
      return 'Up to date';
    case 'ahead':
      return `${commits(status.ahead)} ahead`;
    case 'behind':
      return `${commits(status.behind)} behind`;
    case 'diverged':
      return `Diverged · ${status.ahead} ahead, ${status.behind} behind`;
  }
}

/**
 * The base label (git-status.ts) taken apart: "main at 1a2b3c4" is a branch and a commit, "base
 * 1a2b3c4" a commit alone. Anything else is kept whole as the branch, so nothing is lost.
 */
export function baseParts(label: string): { branch: string | null; commit: string | null } {
  const at = /^(\S+) at ([0-9a-f]{4,40})$/.exec(label);
  if (at) return { branch: at[1]!, commit: at[2]! };
  const bare = /^base ([0-9a-f]{4,40})$/.exec(label);
  if (bare) return { branch: null, commit: bare[1]! };
  return { branch: label, commit: null };
}

/** "$0.42"; a cost under a cent but not zero is "<$0.01". */
export function costText(usage: Pick<SessionUsage, 'costUsd'>): string {
  return usage.costUsd < 0.01 && usage.costUsd > 0 ? '<$0.01' : `$${usage.costUsd.toFixed(2)}`;
}

/**
 * A long value split for cutting in the middle on screen: the head may lose its end to an ellipsis,
 * the tail always shows. The tail is the last path segment, slash included, when that is at most
 * `maxTail` characters; otherwise the last `maxTail` characters. A value no longer than `maxTail`
 * is all head (nothing to keep apart). Joined, the two are always the value.
 */
export function middleSplit(text: string, maxTail: number): { head: string; tail: string } {
  if (text.length <= maxTail || maxTail <= 0) return { head: text, tail: '' };
  const slash = text.lastIndexOf('/');
  const segment = slash > 0 ? text.length - slash : Infinity;
  const tailLength = segment <= maxTail && segment > 1 ? segment : maxTail;
  return { head: text.slice(0, text.length - tailLength), tail: text.slice(text.length - tailLength) };
}

/** A long name cut in the middle to `max` characters, keeping its start and its end. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** Green requires an affirmative mergeability result, not merely passing CI. */
export function pullRequestStatus(pr: PullRequest): { label: string; tone: 'muted' | 'red' | 'green' | 'amber' | 'purple' } {
  if (pr.state === 'merged') return { label: 'Merged', tone: 'purple' };
  if (pr.state === 'closed') return { label: 'Closed', tone: 'muted' };
  if (pr.state === 'draft') return { label: 'Draft', tone: 'muted' };
  if (pr.checks === 'failing') return { label: 'Checks failed', tone: 'red' };
  if (pr.review === 'changes-requested') return { label: 'Changes requested', tone: 'red' };
  if (pr.readiness === 'conflicts') return { label: 'Merge conflicts', tone: 'red' };
  if (pr.checks === 'running') return { label: 'Checks running', tone: 'amber' };
  if (pr.review === 'review-required') return { label: 'Review required', tone: 'amber' };
  if (pr.readiness === 'ready') return { label: 'Ready to merge', tone: 'green' };
  if (pr.readiness === 'behind') return { label: 'Branch behind', tone: 'amber' };
  if (pr.readiness === 'blocked') return { label: 'Merge blocked', tone: 'amber' };
  return { label: 'Open', tone: 'muted' } // readiness not known: say nothing about it;
}

const MERGE_TEXT: Readonly<Record<Exclude<MergeReadiness, 'unknown'>, string>> = {
  ready: 'Ready to merge',
  conflicts: 'Conflicts must be resolved',
  behind: 'Branch is behind its base',
  blocked: 'Blocked by the host’s merge rules',
};

/** The PR page's Merge row: the state when it is no longer open, else what the host says about merging; null (no row) when it has not said. */
export function mergeText(pr: PullRequest): string | null {
  if (pr.state === 'merged') return 'Merged';
  if (pr.state === 'closed') return 'Closed';
  if (pr.state === 'draft') return 'Draft — not ready for review';
  return pr.readiness && pr.readiness !== 'unknown' ? MERGE_TEXT[pr.readiness] : null;
}

/** Prefer the active PR; keep a completed PR visible when it is the only one. */
export function primaryPullRequest(prs: readonly PullRequest[]): PullRequest | undefined {
  return prs.find(p => p.state === 'open') ?? prs.find(p => p.state === 'draft') ?? prs[0];
}
