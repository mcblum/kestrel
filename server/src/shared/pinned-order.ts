// The order of the PINNED section. Pure, shared with the UI.
//   - custom: the order the user dragged the pins into (as stored).
//   - recent: pinned SESSIONS are ordered newest activity first, by the same rule and tie-breaks as
//     every other sidebar list (session-order.ts); a session is placed by the newest activity in
//     its own row (itself and what hangs under it). Pinned PROJECTS and GROUPS do not move: they
//     keep the places the user gave them, exactly as the PROJECTS list and the groups do outside
//     PINNED, and the sessions are sorted into the places in between. (The sessions inside a
//     pinned project or group are ordered by that list's own rule, like any other list.)
import type { TreeNode } from '../model.ts';
import type { PinnedRow } from './pinned-homes.ts';
import { pinKey } from './pins.ts';
import { keyOf, newestFirst, type Lookup, type OrderKey, type SessionOrder } from './session-order.ts';

const walk = (nodes: readonly TreeNode[], into: string[] = []): string[] => {
  for (const n of nodes) {
    into.push(n.sessionId);
    walk(n.children, into);
  }
  return into;
};

/** The newest key among `ids`, or null when none of them is known. */
function newestOf(ids: readonly string[], lookup: Lookup): OrderKey | null {
  let best: OrderKey | null = null;
  for (const id of ids) {
    if (!lookup(id)) continue;
    const key = keyOf(id, lookup);
    if (!best || newestFirst(key, best) < 0) best = key;
  }
  return best;
}

type SessionRow = Extract<PinnedRow, { kind: 'session' }>;

/** The pinned session rows, newest first; one whose sessions are all unknown goes last, in the user's order. */
function sortedSessions<R extends PinnedRow>(rows: readonly R[], lookup: Lookup): R[] {
  const ranked: { row: R; key: OrderKey }[] = [];
  const unknown: R[] = [];
  for (const row of rows) {
    const newest = newestOf(walk([(row as SessionRow).node]), lookup);
    if (newest) ranked.push({ row, key: { ...newest, id: pinKey(row) } });
    else unknown.push(row);
  }
  return [...ranked.sort((a, b) => newestFirst(a.key, b.key)).map((r) => r.row), ...unknown];
}

/** The PINNED rows in the mode's order. Returns the rows given when nothing moved. */
export function orderPinned<R extends PinnedRow>(rows: readonly R[], mode: SessionOrder, lookup: Lookup): R[] {
  if (mode === 'custom') return rows as R[];
  const sessions = sortedSessions(rows.filter((r) => r.kind === 'session'), lookup);
  let next = 0;
  // Projects and groups stay where they are; the sessions take the remaining places in their new order.
  const placed = rows.map((row) => (row.kind === 'session' ? sessions[next++]! : row));
  return placed.every((r, i) => r === rows[i]) ? (rows as R[]) : placed;
}
