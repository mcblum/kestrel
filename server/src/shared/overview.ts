// The Overview's sections: which one each session is listed in, in what order, and what the intro
// line counts. Pure, shared with the UI. Every session the Overview lists is in exactly one section,
// in this order, by what asks for the user first:
//   Needs you       waiting on the user (a question, an approval, a failure); longest waiting first
//   Unread          finished since the user last looked: the sidebar's green dot (unread.ts), so a
//                   session is unread here exactly when its dot is; opening it moves it on
//   Working         an agent is running
//   Ready to review finished with its newest request open (status.ts), already looked at
//   Interrupted     the server restarted under it, already looked at
//   Recently done   finished with nothing waiting on review (no request, or it is merged, closed
//                   or a draft) and looked at, stopped ones included; the newest few, the heading counts them all
import type { SessionView } from '../model.ts';
import { statusOf, type StatusKey, type Statused } from './status.ts';
import { sessionDot, type Seen } from './unread.ts';

export type OverviewSection = 'needs-you' | 'unread' | 'working' | 'review' | 'interrupted' | 'done';
export const OVERVIEW_SECTIONS: readonly OverviewSection[] = ['needs-you', 'unread', 'working', 'review', 'interrupted', 'done'];

/** How many finished sessions "Recently done" shows. */
export const RECENT_DONE = 5;

type Listed = Pick<SessionView, 'id' | 'updatedAt' | 'lastActivityAt'> & Statused;

/** The one section a session is listed in. */
export function overviewSection(session: Listed, seen: Seen | null): OverviewSection {
  const status = statusOf(session);
  if (status === 'needs-you' || status === 'failed') return 'needs-you';
  if (status === 'working') return 'working';
  if (sessionDot(session, seen) === 'unread') return 'unread';
  return status === 'stopped' ? 'done' : status;
}

export interface OverviewSections<T> {
  rows: Record<OverviewSection, T[]>;
  /** Every session in each section (Recently done shows only the newest few of its count). */
  counts: Record<OverviewSection, number>;
}

const newest = (a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt;

/** The sessions sorted into sections: needs you waiting longest first, the rest newest first. */
export function overviewSections<T extends Listed>(sessions: readonly T[], seen: Seen | null): OverviewSections<T> {
  const rows = Object.fromEntries(OVERVIEW_SECTIONS.map((k) => [k, [] as T[]])) as Record<OverviewSection, T[]>;
  for (const s of sessions) rows[overviewSection(s, seen)].push(s);
  const counts = Object.fromEntries(OVERVIEW_SECTIONS.map((k) => [k, rows[k].length])) as Record<OverviewSection, number>;
  for (const k of OVERVIEW_SECTIONS) rows[k].sort(k === 'needs-you' ? (a, b) => -newest(a, b) : newest);
  rows.done = rows.done.slice(0, RECENT_DONE);
  return { rows, counts };
}

/**
 * Does a section's table need its Status column? Only when its rows can say different things:
 * where every row would read the same word, the heading already says it.
 */
export function showsStatus(rows: readonly Statused[]): boolean {
  const seen = new Set<StatusKey>(rows.map(statusOf));
  return seen.size > 1;
}

/** Local calendar dates: adding days (rather than milliseconds) also works across DST. */
export const activityDayKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Thirty local calendar days ending today. Count a session once, including archived sessions. */
export function activityGarden<T extends Pick<SessionView, 'id' | 'completedAt'>>(sessions: readonly T[], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const unique = [...new Map(sessions.map(s => [s.id, s])).values()];
  const completed = unique.filter(s => s.completedAt !== undefined && Number.isFinite(s.completedAt) && s.completedAt <= now.getTime());
  const byDay = new Map<string, T[]>();
  for (const s of completed) {
    const key = activityDayKey(new Date(s.completedAt!));
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = activityDayKey(date);
    const rows = (byDay.get(key) ?? []).sort((a, b) => b.completedAt! - a.completedAt!);
    return { key, date, sessions: rows, level: Math.min(rows.length, 4) };
  });
  return { days, total: days.reduce((sum, day) => sum + day.sessions.length, 0) };
}
