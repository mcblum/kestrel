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
import type { TreeNode } from '../model.ts';
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
}

const finite = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/** When the session last did or received something: its activity time, or `updatedAt` for older records. */
export const activityAt = (s: Pick<Timed, 'updatedAt' | 'lastActivityAt'>): number => finite(s.lastActivityAt) ?? finite(s.updatedAt) ?? 0;

/** A row's sort key: the activity that places it, and what breaks a tie. */
export interface OrderKey {
  at: number;
  createdAt: number;
  id: string;
}

/** Newest activity first; then newer creation; then id, so the order is total and stable. */
export function newestFirst(a: OrderKey, b: OrderKey): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A session the lookup does not know (gone meanwhile) sorts last. */
const UNKNOWN = { at: -Infinity, createdAt: -Infinity };

export type Lookup = (id: string) => Timed | undefined;

export const keyOf = (id: string, lookup: Lookup): OrderKey => {
  const s = lookup(id);
  return s ? { at: activityAt(s), createdAt: finite(s.createdAt) ?? 0, id } : { ...UNKNOWN, id };
};

/** Sort one level of a tree by subtree activity, children too. Returns the nodes given when nothing moved. */
function sortLevel(nodes: readonly TreeNode[], lookup: Lookup): { nodes: TreeNode[]; newest: number } {
  const ranked = nodes.map((node) => {
    const below = sortLevel(node.children, lookup);
    const own = keyOf(node.sessionId, lookup);
    const sameChildren = below.nodes.length === node.children.length && below.nodes.every((c, i) => c === node.children[i]);
    return { node: sameChildren ? node : { ...node, children: below.nodes }, key: { ...own, at: Math.max(own.at, below.newest) } };
  });
  const sorted = [...ranked].sort((a, b) => newestFirst(a.key, b.key));
  const same = sorted.every((r, i) => r.node === nodes[i]);
  return { nodes: same ? (nodes as TreeNode[]) : sorted.map((r) => r.node), newest: ranked.reduce((n, r) => Math.max(n, r.key.at), -Infinity) };
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
