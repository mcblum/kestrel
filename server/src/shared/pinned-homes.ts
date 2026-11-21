// Where each thing in the sidebar is drawn once pins are taken into account. Pure, shared with the
// UI. A pinned item leaves its usual home and shows only under PINNED:
//   - a pinned session (with the sessions hanging under it in its tree) leaves its group's tree,
//     the ungrouped sessions and its project's list;
//   - a pinned group leaves the Sessions list, a pinned project the Projects list, each with
//     everything in it;
//   - a pinned session that is already inside another pinned item (a pinned group, a pinned
//     project, a pinned session above it) is drawn there, once, and has no row of its own. Its
//     pin stays recorded, so it gets its own row again if that item is unpinned;
//   - a session drawn under a pinned session's row is left out of a pinned project's list, so
//     nothing under PINNED shows twice.
//   - a session that is reviewing a request still waiting on the user (`reviewing`) leaves its usual
//     home the same way and shows only under CODE REVIEWS, with what hangs under it; one that is
//     also under PINNED (pinned itself, or inside a pinned item) stays there, once.
// Pinning changes nothing else: membership and order are untouched, so unpinning puts an item
// back exactly where it was. Where an unpinned session is drawn (its group, the Sessions list or
// its project's list, exactly one of them) is decided first, by `sessionHomes` (session-homes.ts).
import type { FilingStatus, TreeNode } from '../model.ts';
import type { PinRef } from './pins.ts';
import { sessionHomes } from './session-homes.ts';

/** What this needs to know about a session. */
export interface HomeSession {
  id: string;
  filing: { projectId: string | null; status: FilingStatus };
}

export interface HomesInput {
  /** The pins in sight, in the user's order. */
  pins: readonly PinRef[];
  /** Tree per group id, plus `ungrouped`. */
  trees: Readonly<Record<string, readonly TreeNode[]>>;
  sessions: readonly HomeSession[];
  /** The sessions reviewing a request that still waits on the user (shared/review-requests.ts `reviewingIds`); none when absent. */
  reviewing?: ReadonlySet<string>;
  /** For each of those sessions, the key of the request it reviews: a pinned request is drawn as its review session's row. */
  reviewKeyOf?: ReadonlyMap<string, string>;
  /** The keys of the requests still listed: a pinned request that is not is not drawn. None when absent. */
  listedReviews?: ReadonlySet<string>;
}

/** One session row of the CODE REVIEWS section, with what hangs under it. */
export interface ReviewRow {
  id: string;
  node: TreeNode;
}

/** One row of the PINNED section. A session row carries its tree node, so what hangs under it is drawn with it. */
export type PinnedRow =
  | { kind: 'session'; id: string; node: TreeNode }
  | { kind: 'group'; id: string }
  | { kind: 'project'; id: string }
  /** A pinned review request, by its key: its review session's row (`node`) once it has one, else its request row. */
  | { kind: 'review'; id: string; node?: TreeNode };

export interface SidebarHomes {
  /** The PINNED section, in the user's order. */
  pinned: PinnedRow[];
  /** Trees for the Sessions list (every key of the input), with pinned sessions and what hangs under them cut out. */
  trees: Record<string, TreeNode[]>;
  /** Pinned groups and projects: drawn under PINNED, not in their lists. */
  pinnedGroups: ReadonlySet<string>;
  pinnedProjects: ReadonlySet<string>;
  /** Sessions that have gone to PINNED with a pinned session: an unpinned project's list leaves them out. */
  pinnedAway: ReadonlySet<string>;
  /** The CODE REVIEWS section's session rows, in the order of `sessions`. */
  reviews: ReviewRow[];
  /** Sessions that have gone to CODE REVIEWS with a review session. */
  reviewAway: ReadonlySet<string>;
  /** Everything that left its usual home, to PINNED or to CODE REVIEWS: a project's list leaves these out. */
  away: ReadonlySet<string>;
  /** Sessions drawn in a pinned session's own row (it and what hangs under it): a pinned project's list leaves them out. */
  inSessionRows: ReadonlySet<string>;
  /** Sessions whose home is their project's list (not a group, not the Sessions list): `projectRowIds`. */
  inProjectList: ReadonlySet<string>;
  /** What is drawn under a row of a project's list (the sessions it delegated to in that project), minus what went to PINNED. */
  nestedInProject: ReadonlyMap<string, TreeNode[]>;
}

const idsOf = (nodes: readonly TreeNode[], into: Set<string> = new Set()): Set<string> => {
  for (const n of nodes) {
    into.add(n.sessionId);
    idsOf(n.children, into);
  }
  return into;
};

/** The tree without the nodes in `cut` (and what hangs under them). Untouched subtrees keep their identity. */
function prune(nodes: readonly TreeNode[], cut: ReadonlySet<string>): TreeNode[] {
  const kept = nodes.filter((n) => !cut.has(n.sessionId));
  let changed = kept.length !== nodes.length;
  const out = kept.map((n) => {
    const children = prune(n.children, cut);
    if (children.length === n.children.length && children.every((c, i) => c === n.children[i])) return n;
    changed = true;
    return { ...n, children };
  });
  return changed ? out : (nodes as TreeNode[]);
}

function nodesById(trees: HomesInput['trees']): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  const walk = (nodes: readonly TreeNode[]) => nodes.forEach((n) => (map.set(n.sessionId, n), walk(n.children)));
  Object.values(trees).forEach(walk);
  return map;
}

/** The sessions listed under a project, in the order given, minus the ones in `leaveOut`. */
export function projectSessionIds(sessions: readonly HomeSession[], projectId: string, leaveOut: ReadonlySet<string> = new Set()): string[] {
  return sessions.filter((s) => s.filing.status !== 'hidden' && s.filing.projectId === projectId && !leaveOut.has(s.id)).map((s) => s.id);
}

/** Every session drawn under the rows `ids` of a project's list. */
export function nestedIds(ids: readonly string[], nestedInProject: ReadonlyMap<string, readonly TreeNode[]>): string[] {
  return ids.flatMap((id) => [...idsOf(nestedInProject.get(id) ?? [])]);
}

/** The rows of a project's list in the sidebar: its sessions whose home is that list, minus `leaveOut`. */
export function projectRowIds(sessions: readonly HomeSession[], projectId: string, inProjectList: ReadonlySet<string>, leaveOut: ReadonlySet<string> = new Set()): string[] {
  return projectSessionIds(sessions, projectId, leaveOut).filter((id) => inProjectList.has(id));
}

/** A session drawn on its own, without what hangs under it (a project's list is flat). */
const flatNode = (sessionId: string): TreeNode => ({ sessionId, via: null, movedFrom: null, children: [] });

/** Where everything in the sidebar is drawn, given what is pinned. */
export function sidebarHomes({ pins, trees: given, sessions, reviewing, reviewKeyOf, listedReviews }: HomesInput): SidebarHomes {
  const { trees, inProjectList, nestedInProject: nestedBeforePins } = sessionHomes(given, sessions);
  const pinnedGroups = new Set(pins.filter((p) => p.kind === 'group').map((p) => p.id));
  const pinnedProjects = new Set(pins.filter((p) => p.kind === 'project').map((p) => p.id));
  const nodes = nodesById(trees);
  // A session at home in a project's list is drawn there with the same-project sessions it
  // delegated to under it, so pinned it is drawn the same way; one of those can be pinned too.
  for (const id of inProjectList) if (!nodes.has(id)) nodes.set(id, { ...flatNode(id), children: nestedBeforePins.get(id) ?? [] });
  for (const below of nestedBeforePins.values()) for (const [id, node] of nodesById({ below })) if (!nodes.has(id)) nodes.set(id, node);
  // A pinned request that has a review session is that session, pinned: it leaves CODE REVIEWS
  // (and its usual home) for PINNED exactly as a pinned session does.
  const reviewOf = new Map<string, string>();
  for (const pin of pins) {
    if (pin.kind !== 'review' || !listedReviews?.has(pin.id)) continue;
    const session = sessions.find((s) => reviewing?.has(s.id) && reviewKeyOf?.get(s.id) === pin.id && nodes.has(s.id));
    if (session) reviewOf.set(pin.id, session.id);
  }
  const pinnedSessionIds = pins.flatMap((p) => (p.kind === 'session' ? [p.id] : p.kind === 'review' ? (reviewOf.get(p.id) ?? []) : []));
  const pinnedSessions = [...new Set(pinnedSessionIds)].filter((id) => nodes.has(id)).map((id) => nodes.get(id)!);

  // Everything drawn inside another pinned item: a pinned group's tree, a pinned project's list,
  // and what hangs under a pinned session.
  const inside = new Set<string>();
  for (const id of pinnedGroups) idsOf(trees[id] ?? [], inside);
  for (const id of pinnedProjects) projectRowIds(sessions, id, inProjectList).forEach((s) => inside.add(s));
  for (const node of pinnedSessions) idsOf(node.children, inside);

  const pinnedAway = new Set<string>();
  for (const node of pinnedSessions) idsOf([node], pinnedAway);

  const sessionPinned = new Set(pins.filter((p) => p.kind === 'session').map((p) => p.id));
  const pinned: PinnedRow[] = pins.flatMap((p): PinnedRow[] => {
    if (p.kind === 'review') {
      if (!listedReviews?.has(p.id)) return [];
      const sessionId = reviewOf.get(p.id);
      if (!sessionId) return [{ kind: 'review', id: p.id }];
      // Its session is already drawn under PINNED, by its own pin or inside another pinned item: once is enough.
      return sessionPinned.has(sessionId) || inside.has(sessionId) ? [] : [{ kind: 'review', id: p.id, node: nodes.get(sessionId)! }];
    }
    if (p.kind !== 'session') return [{ kind: p.kind, id: p.id }];
    const node = nodes.get(p.id);
    return node && !inside.has(p.id) ? [{ kind: 'session', id: p.id, node }] : [];
  });
  const inSessionRows = new Set<string>();
  for (const row of pinned) if ((row.kind === 'session' || row.kind === 'review') && row.node) idsOf([row.node], inSessionRows);
  // What PINNED already draws: a review session there stays there.
  const underPinned = new Set([...pinnedAway, ...inside]);
  const candidates = (reviewing?.size ? sessions : []).flatMap((session) => {
    const node = reviewing!.has(session.id) && !underPinned.has(session.id) ? nodes.get(session.id) : undefined;
    return node ? [{ id: session.id, node }] : [];
  });
  // One hanging under another review session's row is drawn there, once, whichever was started first.
  const below = new Set<string>();
  for (const row of candidates) idsOf(row.node.children, below);
  const reviews: ReviewRow[] = candidates.filter((row) => !below.has(row.id));
  const reviewAway = new Set<string>();
  for (const row of reviews) idsOf([row.node], reviewAway);
  const away = reviewAway.size ? new Set([...pinnedAway, ...reviewAway]) : pinnedAway;
  const pruned = Object.fromEntries(Object.entries(trees).map(([key, tree]) => [key, prune(tree, away)]));
  const nestedInProject = new Map([...nestedBeforePins].map(([id, below]) => [id, prune(below, away)] as const).filter(([, below]) => below.length > 0));
  // A review row's own children are what is left of them once pins are cut out.
  const reviewRows = reviews.map((row) => ({ id: row.id, node: prune([row.node], pinnedAway)[0] ?? row.node }));
  return { pinned, trees: pruned, pinnedGroups, pinnedProjects, pinnedAway, reviews: reviewRows, reviewAway, away, inSessionRows, inProjectList, nestedInProject };
}

/** What an empty list draws: a "Create a session…" row, or a quiet note that its sessions are all pinned. */
export type EmptyListKind = 'create' | 'all-pinned';
export const CREATE_SESSION_LABEL = 'Create a session…';
export const ALL_PINNED_LABEL = 'All sessions pinned';

/**
 * What an open project or group draws when it has no rows: nothing (null) while it has rows;
 * "All sessions pinned" when it has sessions but every one of them is drawn under PINNED (it is not
 * empty, and an item never shows twice); a "Create a session…" row when it has none.
 */
export function emptyListKind(sessionCount: number, rowCount: number): EmptyListKind | null {
  if (rowCount > 0) return null;
  return sessionCount > 0 ? 'all-pinned' : 'create';
}
