// The order of sessions inside each sidebar container (the Sessions list, a group, a project's
// list, a tag's list). Pure, shared with the UI. Two modes, chosen in Settings:
//   - recent (the default): newest activity first. A row with sessions under it (a parent and its
//     delegated or handed-off children) takes its place from the newest activity anywhere in that
//     subtree, so a parent whose child is working stays near the top; children under one parent are
//     ordered the same way. Ties break on creation (newer first), then id, so rows never swap
//     without a cause.
//   - custom: the order the user dragged things into (`arrange`), children as the tree gives them.
// Groups, projects and tags keep the user's order in both modes. PINNED follows the mode too: most
// recent sorts its rows by the newest activity each one holds (pinned-order.ts).
// "Activity" is `lastActivityAt` (a message sent or answered, a turn ending), or `updatedAt` for
// sessions stored before it existed (`activityAt`).
// How recent a session is (Matt, 2026-11-27, issue 83) is one rule, `recencyOf` and `moreRecent`, used
// wherever sessions, trees or workstreams are put in order of recency: a session working right now is
// more recent than every session that is not, however lately that one finished; among working
// sessions, and among the rest, the latest activity first. A row with sessions under it is as recent
// as the most recent of them (`recencyOfAll`), and so is a workstream.
import type { SessionState, TreeNode } from '../model.ts';
import { arrange } from './sidebar.ts';

export type SessionOrder = 'recent' | 'custom';
export const SESSION_ORDERS: readonly SessionOrder[] = ['recent', 'custom'];
export const DEFAULT_SESSION_ORDER: SessionOrder = 'recent';

/** A stored value read back: anything unknown is the default. */
export const parseSessionOrder = (value: unknown): SessionOrder => (SESSION_ORDERS.includes(value as SessionOrder) ? (value as SessionOrder) : DEFAULT_SESSION_ORDER);

/** What ordering needs to know about a session. */
export interface Timed {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
  /** Running is working now, which makes it the most recent. Absent: not working. */
  state?: SessionState;
}

const finite = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/** When the session last did or received something: its activity time, or `updatedAt` for older records. */
export const activityAt = (s: Pick<Timed, 'updatedAt' | 'lastActivityAt'>): number => finite(s.lastActivityAt) ?? finite(s.updatedAt) ?? 0;

/** How recent a session (or a row of several) is: whether it is working now, and its latest activity. */
export interface Recency {
  working: boolean;
  at: number;
}

/** How recent one session is. */
export const recencyOf = (s: Pick<Timed, 'updatedAt' | 'lastActivityAt' | 'state'>): Recency => ({ working: s.state === 'running', at: activityAt(s) });

/** How recent several are together: working when any is, as late as the latest. Nothing at all is never working, at -Infinity. */
export const recencyOfAll = (all: readonly Recency[]): Recency => ({ working: all.some((r) => r.working), at: all.reduce((n, r) => Math.max(n, r.at), -Infinity) });

/** The more recent first: working ahead of not working, then the latest activity. 0 when the two are as recent. */
export function moreRecent(a: Recency, b: Recency): number {
  if (a.working !== b.working) return a.working ? -1 : 1;
  return a.at === b.at ? 0 : b.at > a.at ? 1 : -1;
}

/** Whether a session counts as active since `since` (ms): working now, or active since then. */
export const activeSince = (s: Pick<Timed, 'updatedAt' | 'lastActivityAt' | 'state'>, since: number): boolean => {
  const r = recencyOf(s);
  return r.working || r.at >= since;
};

/** A row's sort key: how recent it is, and what breaks a tie. */
export interface OrderKey extends Recency {
  createdAt: number;
  id: string;
}

/** The most recent first (`moreRecent`); then newer creation; then id, so the order is total and stable. */
export function newestFirst(a: OrderKey, b: OrderKey): number {
  const recent = moreRecent(a, b);
  if (recent !== 0) return recent;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A session the lookup does not know (gone meanwhile) sorts last. */
const UNKNOWN = { working: false, at: -Infinity, createdAt: -Infinity };

export type Lookup = (id: string) => Timed | undefined;

export const keyOf = (id: string, lookup: Lookup): OrderKey => {
  const s = lookup(id);
  return s ? { ...recencyOf(s), createdAt: finite(s.createdAt) ?? 0, id } : { ...UNKNOWN, id };
};

/** Sort one level of a tree by how recent each subtree is, children too. Returns the nodes given when nothing moved. */
function sortLevel(nodes: readonly TreeNode[], lookup: Lookup): { nodes: TreeNode[]; newest: Recency } {
  const ranked = nodes.map((node) => {
    const below = sortLevel(node.children, lookup);
    const own = keyOf(node.sessionId, lookup);
    const sameChildren = below.nodes.length === node.children.length && below.nodes.every((c, i) => c === node.children[i]);
    return { node: sameChildren ? node : { ...node, children: below.nodes }, key: { ...own, ...recencyOfAll([own, below.newest]) } };
  });
  const sorted = [...ranked].sort((a, b) => newestFirst(a.key, b.key));
  const same = sorted.every((r, i) => r.node === nodes[i]);
  return { nodes: same ? (nodes as TreeNode[]) : sorted.map((r) => r.node), newest: recencyOfAll(ranked.map((r) => r.key)) };
}

/** How recent a tree is: the most recent of its sessions. */
export function treeRecency(node: TreeNode, lookup: Lookup): Recency {
  const s = lookup(node.sessionId);
  return recencyOfAll([...(s ? [recencyOf(s)] : []), ...node.children.map((c) => treeRecency(c, lookup))]);
}

/**
 * The rows of one container, in the mode's order. Recent: every level by subtree activity.
 * Custom: top rows in the dragged `order` (rows it does not know yet come first), children as given.
 */
export function orderTree(nodes: readonly TreeNode[], lookup: Lookup, mode: SessionOrder, order: readonly string[]): TreeNode[] {
  if (mode === 'custom') return arrange(nodes, (n) => n.sessionId, order);
  return sortLevel(nodes, lookup).nodes;
}

/** A flat list of sessions (a project's, a tag's) in the mode's order. Custom keeps `order`, or the list as given when there is none. */
export function orderSessions<T extends Timed>(sessions: readonly T[], mode: SessionOrder, order: readonly string[] | null): T[] {
  if (mode === 'custom') return order ? arrange(sessions, (s) => s.id, order) : [...sessions];
  return [...sessions].sort((a, b) => newestFirst(keyOf(a.id, () => a), keyOf(b.id, () => b)));
}
