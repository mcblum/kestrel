// The one answer to "which worktree does this session work in": its own, or for a guest
// (shared/worktree-guests.ts) its host's, or none, with the reason. Every place that follows the
// working tree (the folder a pane opens in, git status and counts, the Changes list, the checkout a
// pull request is made from, which pull requests a session shows) reads it here, never
// `worktreePath` or `branch` directly. What is about owning a worktree (cleanup, discarding, the
// storage list, the one-writer rule, filing) still reads the session's own fields.
// Pure and browser-safe: whether the folder is still on disk is checked by the server
// (working-tree-disk.ts).
import type { Session } from '../model.ts';

export type TreeSession = Pick<Session, 'id' | 'title' | 'worktreePath' | 'branch' | 'worktreeDiscarded' | 'hostId'>;

/** The session a guest works for, named. */
export interface HostRef {
  id: string;
  title: string;
}

export interface WorkingTree {
  path: string;
  /** The branch recorded for the worktree; null when none is. */
  branch: string | null;
  /** Whose worktree it is: the session itself, or its host. */
  ownerId: string;
  /** Set for a guest: the session whose worktree this is. */
  host: HostRef | null;
}

export type WorkingTreeAnswer = { tree: WorkingTree } | { tree: null; reason: string; host: HostRef | null; discarded: boolean };

/** A session by id: the shown ones, then the archived (a host may be archived while its guest is not). */
export type FindSession = (id: string) => TreeSession | undefined;

export const MAIN_CHECKOUT = 'This session works in the main checkout, so it has no base to compare with';
export const DISCARDED = 'The worktree was discarded';
export const HOST_GONE = 'The session whose worktree this one worked in is gone';

const hostWorks = (title: string) => `"${title}" works in the main checkout, so there is no worktree to compare with`;
const hostDiscarded = (title: string) => `The worktree of "${title}", where this session worked, was discarded`;

/** Where `session` works: its worktree, its host's for a guest, or null with the reason. */
export function workingTreeOf(session: TreeSession, find: FindSession): WorkingTreeAnswer {
  if (session.hostId) {
    const host = find(session.hostId);
    if (!host) return { tree: null, reason: HOST_GONE, host: null, discarded: false };
    const ref = { id: host.id, title: host.title };
    if (host.worktreeDiscarded) return { tree: null, reason: hostDiscarded(host.title), host: ref, discarded: true };
    if (!host.worktreePath) return { tree: null, reason: hostWorks(host.title), host: ref, discarded: false };
    return { tree: { path: host.worktreePath, branch: host.branch, ownerId: host.id, host: ref } };
  }
  if (session.worktreeDiscarded) return { tree: null, reason: DISCARDED, host: null, discarded: true };
  if (!session.worktreePath) return { tree: null, reason: MAIN_CHECKOUT, host: null, discarded: false };
  return { tree: { path: session.worktreePath, branch: session.branch, ownerId: session.id, host: null } };
}

/** A finder over the workspace's sessions, shown then archived. */
export function sessionFinder(state: { sessions: readonly TreeSession[]; archived?: { sessions: readonly TreeSession[] } }): FindSession {
  const byId = new Map<string, TreeSession>();
  for (const s of state.archived?.sessions ?? []) byId.set(s.id, s);
  for (const s of state.sessions) byId.set(s.id, s);
  return (id) => byId.get(id);
}

/** The branch a session's pull requests and git state are about: its working tree's, or null. */
export const workingBranchOf = (answer: WorkingTreeAnswer): string | null => answer.tree?.branch ?? null;

/**
 * The session whose pull requests and request links a session shows: the owner of the worktree it
 * works in. A guest shows its host's, held once under the host's id, so a request is never listed
 * or counted twice.
 */
export const worktreeOwnerId = (session: Pick<Session, 'id' | 'hostId'>): string => session.hostId ?? session.id;

/**
 * Whose pull requests a session shows, and on which branch: the worktree owner's (`worktreeOwnerId`),
 * with the branch recorded on the owner, which is kept after its worktree is discarded so its requests
 * still show.
 */
export function requestSideOf(session: TreeSession, find: FindSession): { ownerId: string; branch: string | null } {
  const ownerId = worktreeOwnerId(session);
  return { ownerId, branch: (ownerId === session.id ? session : find(ownerId))?.branch ?? null };
}

/** The sessions that share `ownerId`'s worktree, the owner first: it and its guests. */
export function worktreeSharers<S extends Pick<Session, 'id' | 'hostId'>>(sessions: readonly S[], ownerId: string): S[] {
  return sessions.filter((s) => s.id === ownerId || s.hostId === ownerId).sort((a, b) => (a.id === ownerId ? -1 : b.id === ownerId ? 1 : 0));
}

/** What the window says about where a guest works, in plain words. */
export const guestWhere = (host: HostRef): string => `Working in “${host.title}”’s worktree`;
