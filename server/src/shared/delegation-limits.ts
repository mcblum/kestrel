// Delegation limits as a setting (Settings → Workflow → Delegation limits; Matt, 2026-11-19). The
// defaults are the ones the design doc proposed on 2026-11-13; the user may change each within its
// range. Pure: the server checks what it stores with these, and the page checks what is typed
// with the same functions, so the two always agree on what is allowed and why.

export interface DelegationLimits {
  /** Children one `delegate` call may start. */
  maxChildrenPerDelegate: number;
  /** Levels below a tree's first session. A child is level 1, its child level 2. */
  maxDepth: number;
  /** Sessions running or waiting at once in one tree (`spawn` counts against the caller's tree). */
  maxLiveSessionsPerTree: number;
}

export type LimitKey = keyof DelegationLimits;

export const LIMIT_KEYS: readonly LimitKey[] = ['maxChildrenPerDelegate', 'maxDepth', 'maxLiveSessionsPerTree'];

export const DEFAULT_LIMITS: DelegationLimits = { maxChildrenPerDelegate: 5, maxDepth: 2, maxLiveSessionsPerTree: 10 };

/**
 * What each limit may be set to. Every check, tree walk, sidebar row and permission rule works at
 * any depth (they recurse: `depthOf`, `subtreeIds`, `buildTree`, `childPermission` from parent to
 * child, each child's own sandbox), so the caps are about what a person can follow, not what breaks:
 * - per delegate 10: one approval card lists every task, and each starts an agent at once.
 * - depth 4: each level indents its sidebar row one step (14px), and a report travels up one
 *   level per turn; past four the tree is hard to read in a sidebar of normal width.
 * - live per tree 30: every live session is an agent process of its own on this Mac.
 */
export const LIMIT_RANGES: Readonly<Record<LimitKey, { min: number; max: number }>> = {
  maxChildrenPerDelegate: { min: 1, max: 10 },
  maxDepth: { min: 1, max: 4 },
  maxLiveSessionsPerTree: { min: 1, max: 30 },
};

/** What each limit is called on the settings page and in refusals. */
export const LIMIT_LABELS: Readonly<Record<LimitKey, string>> = {
  maxChildrenPerDelegate: 'Sessions one delegate call may start',
  maxDepth: 'Levels a session tree may go down',
  maxLiveSessionsPerTree: 'Sessions at work at once in one tree',
};

/** Why `value` cannot be the limit `key`, or null when it can. */
export function limitProblem(key: LimitKey, value: unknown): string | null {
  const { min, max } = LIMIT_RANGES[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${LIMIT_LABELS[key]} must be a whole number from ${min} to ${max}.`;
  if (value < min || value > max) return `${LIMIT_LABELS[key]} must be from ${min} to ${max}; ${value} is outside that.`;
  return null;
}

/** A sent value checked strictly: every limit present and in range, or the first problem. */
export function checkLimits(raw: unknown): { ok: true; limits: DelegationLimits } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'limits must be { maxChildrenPerDelegate, maxDepth, maxLiveSessionsPerTree }.' };
  const values = raw as Record<string, unknown>;
  for (const key of LIMIT_KEYS) {
    const problem = limitProblem(key, values[key]);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, limits: { maxChildrenPerDelegate: values.maxChildrenPerDelegate as number, maxDepth: values.maxDepth as number, maxLiveSessionsPerTree: values.maxLiveSessionsPerTree as number } };
}

/** A stored value made safe: absent, unreadable or out of range, each limit is its default. */
export function sanitizeLimits(raw: unknown): DelegationLimits {
  const values = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (key: LimitKey): number => (limitProblem(key, values[key]) === null ? (values[key] as number) : DEFAULT_LIMITS[key]);
  return { maxChildrenPerDelegate: pick('maxChildrenPerDelegate'), maxDepth: pick('maxDepth'), maxLiveSessionsPerTree: pick('maxLiveSessionsPerTree') };
}

/** What GET and PATCH answer: the limits in force, and the defaults beside them. */
export interface DelegationLimitsView {
  limits: DelegationLimits;
  defaults: DelegationLimits;
}
