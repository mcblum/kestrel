// How many of a project's sessions the sidebar shows at once (Matt, 2026-11-22: the sidebar was hard
// to read with every session of every project listed). Sessions that need the user come first; a
// session that has been quiet for a day (nothing new, nothing running, nothing asked) is folded
// behind one "N more" line, and so is anything past the first few. The open session is always shown.
// Pure, shared with the UI.
import type { RowDot } from './unread.ts';

/** Rows shown before the rest are folded. */
export const FOLD_LIMIT = 6;
/** A finished session quiet this long is folded, in ms. */
export const QUIET_AFTER = 24 * 60 * 60 * 1000;

export interface FoldItem {
  id: string;
  /** Its dot (`dotFor`): needs-you, unread, working or none. */
  dot: RowDot;
  /** When it last did anything (`activityAt`). */
  activityAt: number;
}

export interface Folded<T> {
  shown: T[];
  folded: T[];
}

/** A row that asks nothing of the user and has been still for a day. */
export const isQuiet = (item: FoldItem, now: number): boolean => item.dot === 'none' && now - item.activityAt >= QUIET_AFTER;

/**
 * Split rows, already in the user's order, into what is shown and what is folded. Rows that need the
 * user move to the top, otherwise the order is kept. Quiet rows fold, then anything past `limit`; the
 * open session and anything that needs the user or is working never fold.
 */
export function foldRows<T extends FoldItem>(rows: readonly T[], { now, activeId, limit = FOLD_LIMIT }: { now: number; activeId: string | null; limit?: number }): Folded<T> {
  const ordered = [...rows.filter((r) => r.dot === 'needs-you'), ...rows.filter((r) => r.dot !== 'needs-you')];
  const shown: T[] = [];
  const folded: T[] = [];
  for (const row of ordered) {
    const kept = row.id === activeId || row.dot === 'needs-you' || row.dot === 'working';
    if (kept || (!isQuiet(row, now) && shown.length < limit)) shown.push(row);
    else folded.push(row);
  }
  return { shown, folded };
}
