// Workstreams and session trees across the computers of one account (issue 83; docs/designs/account-sessions.md,
// "Workstreams on another computer, as built"). A computer says, in each session's head, how that session was
// started (its link: the parent and the kind) and the workstream it is in, so every other computer can draw the
// session's tree and the workstream as that computer does: the lead's row with the sessions under it in the
// sidebar, the workstream's page, and the session map.
//
// - A head says only what may leave the computer: the link only when its parent's head is published too, and of the
//   workstream only the sessions whose heads are published. A project kept off Kestrel Connect has no heads, so none
//   of its sessions is referenced. The workstream's name and objective are user text: they travel sealed inside the
//   head, as a session's title does.
// - A workstream is known by its own id. Every head of one of its sessions carries a copy; the copies are merged
//   here and nowhere else (`remoteWorkstreams`): the copy its lead's head carries wins, else the copy carried by the
//   most recently updated head. A workstream this computer holds itself is its own, whatever another computer says.
// - What another computer sends is read through `asHeadLink` and `asHeadWorkstream` and nowhere else.
import type { Link, LinkKind, Workstream, WorkstreamStatus } from '../model.ts';
import type { AccountHead, Machine } from './machines.ts';
import { shownWorkstreams, WORKSTREAM_NAME_MAX, WORKSTREAM_OBJECTIVE_MAX } from './workstreams.ts';

/** How a session was started, as its head says it: the session that started it and how. */
export interface HeadLink {
  parentId: string;
  kind: LinkKind;
}

/** A workstream as a head carries it. */
export interface HeadWorkstream {
  id: string;
  name: string;
  objective: string;
  createdAt: number;
  /** Its sessions whose heads are published, in the order they joined (the lead first). */
  sessionIds: string[];
  status: WorkstreamStatus;
  archivedAt: number | null;
}

const LINK_KINDS: readonly LinkKind[] = ['handoff', 'delegate', 'fork'];
const MAX_SESSIONS = 200;

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const id = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null);
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** The link that started `sessionId`, as its head says it: none when it was not started by a session, or its parent's head is not published. */
export function headLinkOf(sessionId: string, links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[], published: ReadonlySet<string>): HeadLink | null {
  const link = links.find((l) => l.childId === sessionId);
  return link && published.has(link.parentId) ? { parentId: link.parentId, kind: link.kind } : null;
}

/** The workstream `sessionId` is in, as its head says it: only its sessions whose heads are published. None when it is in none. */
export function headWorkstreamOf(sessionId: string, workstreams: readonly Workstream[], published: ReadonlySet<string>): HeadWorkstream | null {
  const w = workstreams.find((x) => x.sessionIds.includes(sessionId));
  if (!w) return null;
  return { id: w.id, name: w.name, objective: w.objective, createdAt: w.createdAt, sessionIds: w.sessionIds.filter((s) => published.has(s)), status: w.status ?? 'active', archivedAt: w.archivedAt ?? null };
}

/** A head's link as opened, or null when it is not one. */
export function asHeadLink(raw: unknown): HeadLink | null {
  const r = obj(raw);
  const parentId = r && id(r.parentId);
  return r && parentId && LINK_KINDS.includes(r.kind as LinkKind) ? { parentId, kind: r.kind as LinkKind } : null;
}

/** A head's workstream as opened, or null when it is not one. */
export function asHeadWorkstream(raw: unknown): HeadWorkstream | null {
  const r = obj(raw);
  const wid = r && id(r.id);
  if (!r || !wid || typeof r.name !== 'string' || !Array.isArray(r.sessionIds)) return null;
  const sessionIds = [...new Set(r.sessionIds.flatMap((s) => id(s) ?? []))].slice(0, MAX_SESSIONS);
  return {
    id: wid,
    name: r.name.slice(0, WORKSTREAM_NAME_MAX) || 'Workstream',
    objective: typeof r.objective === 'string' ? r.objective.slice(0, WORKSTREAM_OBJECTIVE_MAX) : '',
    createdAt: time(r.createdAt) ?? 0,
    sessionIds,
    status: r.status === 'complete' ? 'complete' : 'active',
    archivedAt: time(r.archivedAt),
  };
}

/**
 * The links the other computers' sessions were started by, as their heads say them, for the sessions this
 * computer does not have itself (`own`). Each is known by its child, as a session has one start.
 */
export function remoteLinks(heads: readonly Pick<AccountHead, 'id' | 'link'>[], own: ReadonlySet<string>): Link[] {
  return heads.flatMap((h) => (h.link && !own.has(h.id) ? [{ id: `account|${h.id}`, parentId: h.link.parentId, childId: h.id, kind: h.link.kind }] : []));
}

/**
 * The workstreams the other computers hold, merged by id, for a window to draw beside this computer's own: active
 * ones with the sessions in sight (`shown`), archived ones whole, as `shownWorkstreams` lists this computer's. A
 * workstream whose id this computer holds (`own`) is left out. Each is marked with the computer that holds it.
 */
export function remoteWorkstreams(heads: readonly Pick<AccountHead, 'id' | 'runsOn' | 'updatedAt' | 'workstream'>[], machines: readonly Machine[], own: ReadonlySet<string>, shown: ReadonlySet<string>): { active: Workstream[]; archived: Workstream[] } {
  const best = new Map<string, { copy: HeadWorkstream; runsOn: string; lead: boolean; at: number }>();
  for (const h of heads) {
    const copy = h.workstream;
    if (!copy || own.has(copy.id)) continue;
    const lead = copy.sessionIds[0] === h.id;
    const was = best.get(copy.id);
    // The lead's copy wins; else the copy of the head updated last (one computer's copies differ only while an upload is under way).
    if (was && ((was.lead && !lead) || (was.lead === lead && was.at >= h.updatedAt))) continue;
    best.set(copy.id, { copy, runsOn: h.runsOn, lead, at: h.updatedAt });
  }
  const all = [...best.values()]
    .sort((a, b) => a.copy.createdAt - b.copy.createdAt || a.copy.id.localeCompare(b.copy.id))
    .map(({ copy, runsOn }): Workstream => {
      const machine = machines.find((m) => m.id === runsOn);
      return { ...copy, heldOn: { id: runsOn, name: machine?.name ?? 'another computer' } };
    });
  return shownWorkstreams(all, shown);
}

/** Why a workstream another computer holds is not changed from here (renamed, completed, archived, deleted, its sessions moved). Null for one of this computer's. */
export function remoteWorkstreamRefusal(w: Pick<Workstream, 'name' | 'heldOn'>): string | null {
  return w.heldOn ? `“${w.name}” is on ${w.heldOn.name}, so it can only be changed there.` : null;
}
