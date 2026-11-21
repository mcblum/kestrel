// How groups and links combine into sidebar rows ("How groups and links combine" in the design doc).
import type { Link, LinkKind, TreeNode } from './model.ts';

/** The kind of link that makes a session a child of another: only a delegation. */
export type ChildKind = 'delegate';

/**
 * Whether a link makes one session part of another's work. Only a delegation does (Matt,
 * 2026-11-20): the delegate works for the session that started it, is drawn under it, moves and
 * stops with it, counts against its limits and reports back to it. A handoff is clean: the task
 * moved, the caller is finished, and the two sessions are siblings from then on. A fork carries on
 * from a copy of the conversation. Both are lineage only: where a session came from, never whose
 * child it is.
 */
export const isChildLink = <L extends Pick<Link, 'kind'>>(link: L): link is L & { kind: ChildKind } => link.kind === 'delegate';

/** The kinds of link made when one session starts another to do work: the task moved to it, or part of it was given to it. */
export type StartKind = 'handoff' | 'delegate';

/**
 * The link by which another session started `id` (handoff or delegate), if one did. Such a session
 * is held to its own folder and is filed under the project it was started in, child or not.
 */
export const startLinkOf = <L extends Pick<Link, 'childId' | 'kind'>>(id: string, links: readonly L[]): (L & { kind: StartKind }) | undefined =>
  links.find((l): l is L & { kind: StartKind } => l.childId === id && (l.kind === 'handoff' || l.kind === 'delegate'));

/** How many handoffs in a row led to `id`: the sessions the task passed through to get here. */
export function handoffChain(id: string, links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[]): number {
  const seen = new Set<string>();
  let count = 0;
  let current = id;
  for (;;) {
    seen.add(current);
    const up = links.find((l) => l.childId === current && l.kind === 'handoff');
    if (!up || seen.has(up.parentId)) return count;
    count++;
    current = up.parentId;
  }
}

/** The link that makes `id` a child of another session, if any. */
export const childLinkOf = <L extends Pick<Link, 'childId' | 'kind'>>(id: string, links: readonly L[]): (L & { kind: ChildKind }) | undefined =>
  links.find((l): l is L & { kind: ChildKind } => l.childId === id && isChildLink(l));

/**
 * Draw the sessions of one group (or the ungrouped sessions) as a tree using links.
 * A delegate whose parent is in the same scope is drawn under it. One whose parent is elsewhere
 * (it was dragged out on its own) is drawn at the top level with a "from" mark. A session a task
 * was handed off to is never drawn under the one that handed it off: it is a row of its own, a
 * sibling, with the same "from" mark. `sessionIds` gives the display order.
 */
export function buildTree(sessionIds: readonly string[], links: readonly Link[]): TreeNode[] {
  const inScope = new Set(sessionIds);
  const parentLink = new Map<string, Link>();
  for (const l of links) if (isChildLink(l) && !parentLink.has(l.childId)) parentLink.set(l.childId, l);
  const handedFrom = new Map<string, string>();
  for (const l of links) if (l.kind === 'handoff' && !handedFrom.has(l.childId)) handedFrom.set(l.childId, l.parentId);

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of sessionIds) {
    const up = parentLink.get(id);
    if (up && inScope.has(up.parentId) && up.parentId !== id) {
      childrenOf.set(up.parentId, [...(childrenOf.get(up.parentId) ?? []), id]);
    } else {
      roots.push(id);
    }
  }

  const seen = new Set<string>();
  const node = (id: string, isRoot: boolean): TreeNode => {
    seen.add(id);
    const up = parentLink.get(id);
    return {
      sessionId: id,
      via: !isRoot && up ? up.kind : null,
      movedFrom: isRoot ? (up?.parentId ?? handedFrom.get(id) ?? null) : null,
      children: (childrenOf.get(id) ?? []).filter((c) => !seen.has(c)).map((c) => node(c, false)),
    };
  };
  const tree = roots.map((id) => node(id, true));
  // A cycle in the links would leave sessions unreachable from any root; never drop a row.
  for (const id of sessionIds) if (!seen.has(id)) tree.push(node(id, true));
  return tree;
}

/** A session and everything below it: the sessions it delegated to, and theirs. A handoff or a fork is not below it. */
export function subtreeIds(rootId: string, links: readonly Link[]): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const l of links) if (l.parentId === id && isChildLink(l)) walk(l.childId);
  };
  walk(rootId);
  return out;
}

/** The topmost ancestor of a session. */
export function rootOf(id: string, links: readonly Link[]): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    seen.add(current);
    const up = childLinkOf(current, links);
    if (!up || seen.has(up.parentId)) return current;
    current = up.parentId;
  }
}

/** Number of links between a session and the top of its tree. */
export function depthOf(id: string, links: readonly Link[]): number {
  const seen = new Set<string>();
  let depth = 0;
  let current = id;
  for (;;) {
    seen.add(current);
    const up = childLinkOf(current, links);
    if (!up || seen.has(up.parentId)) return depth;
    depth++;
    current = up.parentId;
  }
}
