// Settings → Archived, grouped: an archived workstream lists the archived sessions it points at
// under itself, so what was put away together is found together. Pure. A session shows once: under
// its archived workstream, or in the flat list when it has none.
import { matchingArchived, type ArchivedRow } from './archived-search.ts';
import type { Workstream } from '../model.ts';

export interface GroupableRow extends ArchivedRow {
  id: string;
  /** It can be restored by itself (a session hidden with its project or group cannot). */
  restore: boolean;
}

export interface ArchivedGroup<T extends GroupableRow> {
  row: T;
  /** A workstream's archived sessions, in the order they joined it. Empty for anything else. */
  under: T[];
  /**
   * The sessions "Restore workstream and its sessions" brings back with it. Set only when every
   * session the workstream points at is archived and restorable: a workstream restored alone would
   * have no session in sight, and would not show.
   */
  restoreWith: string[];
}

type Pointing = Pick<Workstream, 'id' | 'sessionIds'>;

export function groupArchived<T extends GroupableRow>(rows: readonly T[], workstreams: readonly Pointing[]): ArchivedGroup<T>[] {
  const sessions = new Map(rows.filter((r) => r.kind === 'session').map((r) => [r.id, r]));
  const pointing = new Map(workstreams.map((w) => [w.id, w]));
  const claimed = new Set<string>();
  const groups = rows.flatMap((row): ArchivedGroup<T>[] => {
    if (row.kind === 'session') return [];
    const workstream = row.kind === 'workstream' ? pointing.get(row.id) : undefined;
    if (!workstream) return [{ row, under: [], restoreWith: [] }];
    const under = workstream.sessionIds.flatMap((id) => (sessions.has(id) && !claimed.has(id) ? [sessions.get(id)!] : []));
    for (const session of under) claimed.add(session.id);
    const whole = under.length === workstream.sessionIds.length && under.every((s) => s.restore);
    return [{ row, under, restoreWith: whole ? under.map((s) => s.id) : [] }];
  });
  const loose = rows.filter((r) => r.kind === 'session' && !claimed.has(r.id)).map((row): ArchivedGroup<T> => ({ row, under: [], restoreWith: [] }));
  return [...groups, ...loose];
}

/**
 * What a typed search shows. A row that matches keeps everything under it; one that does not is
 * still shown when a session under it matches, with only those sessions.
 */
export function matchingArchivedGroups<T extends GroupableRow>(groups: readonly ArchivedGroup<T>[], query: string): ArchivedGroup<T>[] {
  if (!query.trim()) return [...groups];
  return groups.flatMap((group) => {
    if (matchingArchived([group.row], query).length > 0) return [group];
    const under = matchingArchived(group.under, query);
    return under.length > 0 ? [{ ...group, under }] : [];
  });
}

/** "3 sessions", "2 of 3 sessions archived", "3 sessions, all archived · complete": an archived workstream's detail. */
export function workstreamArchiveDetail(total: number, archived: number, complete: boolean): string {
  const sessions = `${total} session${total === 1 ? '' : 's'}`;
  const which = archived === 0 ? sessions : archived < total ? `${archived} of ${sessions} archived` : `${sessions}, ${total === 1 ? '' : 'all '}archived`;
  return complete ? `${which} · complete` : which;
}

/** The workstream's Restore, which says so when it brings sessions back too. */
export function restoreWorkstreamLabel(sessions: number): string {
  return sessions === 0 ? 'Restore' : `Restore workstream and its ${sessions === 1 ? 'session' : `${sessions} sessions`}`;
}
