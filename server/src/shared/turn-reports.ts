// Who is told that a session's turn ended, and as what. One turn, one message per session: a
// session that is at once an asker (`ask_session`), the delegate parent and a waiter (`wait_for`)
// hears it once, as the most specific of them (design doc, "Hearing back"). Pure.

/** Why a session is told: it asked for this turn, it delegated the work, or it was waiting on it. */
export type ReportRole = 'asker' | 'parent' | 'waiter';

export interface ReportCandidates {
  /** Sessions that asked for this turn (`ask_session`). */
  askers: readonly string[];
  /** The delegate parent, when it is to hear about this turn at all (`parentHears`); else null. */
  parent: string | null;
  /** Sessions whose wait on this one ended with this turn. */
  waiters: readonly string[];
}

/** Most specific first: what a session asked for, then the work it delegated, then a wait. */
const ORDER: readonly ReportRole[] = ['asker', 'parent', 'waiter'];

/** Each session to tell, once, with the role it is told in. In the order they were named. */
export function turnReports(c: ReportCandidates): { to: string; as: ReportRole }[] {
  const byRole: Record<ReportRole, readonly string[]> = { asker: c.askers, parent: c.parent ? [c.parent] : [], waiter: c.waiters };
  const seen = new Set<string>();
  return ORDER.flatMap((as) =>
    byRole[as].flatMap((to) => {
      if (seen.has(to)) return [];
      seen.add(to);
      return [{ to, as }];
    }),
  );
}

/**
 * Whether a delegate parent hears that its child's turn ended. A turn the user started by writing in
 * the child is theirs: the parent did not ask for it and is not woken by it (Matt, 2026-11-18). The
 * delegated work itself, news from other sessions, and a turn someone asked for all report.
 */
export const parentHears = (turn: { byUser: boolean }): boolean => !turn.byUser;
