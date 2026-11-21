// The dot beside a session in the sidebar and on its tab. It says what is waiting for the user,
// not what state the session is in. Pure.
// It goes by activity (`activityAt`: a turn starting or ending, the agent asking), not by any change
// to the record, so moving, renaming, tagging or pinning a session never makes it green.
import type { SessionState } from '../model.ts';
import { activityAt } from './session-order.ts';

/** What the dot reads of a session. */
type Active = { id: string; updatedAt: number; lastActivityAt?: number };

/**
 * - `needs-you`: the agent is waiting for an answer (yellow). Shown until it is answered.
 * - `unread`: it finished or stopped since the user last looked (green).
 * - `working`: the agent is busy; nothing to read yet.
 * - `none`: nothing new.
 */
export type RowDot = 'needs-you' | 'unread' | 'working' | 'none';

/** When each session was last looked at: session id -> its activity time (`activityAt`) then. */
export type Seen = Readonly<Record<string, number>>;

export function rowDot(state: SessionState, updatedAt: number, seenAt: number | undefined): RowDot {
  if (state === 'attention') return 'needs-you';
  if (state === 'running') return 'working';
  return seenAt === undefined || updatedAt > seenAt ? 'unread' : 'none';
}

/**
 * A session's dot, given the record of what was looked at. `seen` is null until the first run has
 * recorded what exists; nothing is unread before then. The sidebar, the tabs and the Overview's
 * Unread section all ask this.
 */
export const sessionDot = (session: Active & { state: SessionState }, seen: Seen | null): RowDot => dotSeenAt(session, seen === null, seen?.[session.id]);

/**
 * The same, given only this session's entry: for a row that subscribes to its own entry and not
 * the whole record. `firstRun` while nothing has been recorded yet.
 */
export function dotSeenAt(session: Active & { state: SessionState }, firstRun: boolean, seenAt: number | undefined): RowDot {
  const at = activityAt(session);
  return rowDot(session.state, at, firstRun ? at : seenAt);
}

/** The dot for a project or group: yellow if anything in it needs the user, else green if anything is unread. */
export function summaryDot(dots: readonly RowDot[]): 'needs-you' | 'unread' | 'none' {
  return dots.includes('needs-you') ? 'needs-you' : dots.includes('unread') ? 'unread' : 'none';
}

/** Record that a session was looked at. Returns the same object when nothing changes. */
export function markSeen(seen: Seen, session: Active): Seen {
  const at = activityAt(session);
  return seen[session.id] === at ? seen : { ...seen, [session.id]: at };
}

/** Everything that exists now counts as looked at (first run, when nothing is stored yet). */
export function seenAll(sessions: readonly Active[]): Seen {
  return Object.fromEntries(sessions.map((s) => [s.id, activityAt(s)]));
}

/** Stored data, kept only where it is an id with a number; entries for sessions that are gone are dropped when `ids` is given. */
export function sanitizeSeen(value: unknown, ids?: ReadonlySet<string>): Seen {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, at]) => typeof at === 'number' && Number.isFinite(at) && id.length < 200 && (!ids || ids.has(id))).slice(0, 5000));
}
