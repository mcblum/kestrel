// The worktree a session works in, for the window: its own, or for a guest its host's
// (@kestrel/server/working-tree, the one function the server uses too). The host's row is read
// from the store through a selector, so a row re-renders only when its own session or its host
// changes.
import { useMemo } from 'react';
import type { SessionView } from '@kestrel/server/model';
import { requestSideOf, workingTreeOf, worktreeOwnerId, type TreeSession, type WorkingTreeAnswer } from '@kestrel/server/working-tree';
import { useApp } from './store.ts';

/** A guest's host as the store holds it (shown or archived); undefined for any other session. */
function useHost(hostId: string | undefined): SessionView | undefined {
  return useApp((s) => (hostId ? (s.sessionsById.get(hostId) ?? s.workspace?.archived.sessions.find((x) => x.id === hostId)) : undefined));
}

/** Where `session` works: the tree and its branch, or the reason there is none. */
export function useWorkingTree(session: TreeSession): WorkingTreeAnswer {
  const host = useHost(session.hostId);
  return useMemo(() => workingTreeOf(session, (id) => (id === host?.id ? host : undefined)), [session, host]);
}

/**
 * Whose pull requests a session shows, and on which branch (`requestSideOf`): a guest's are its
 * host's, held once in the store under the host, so nothing is listed or counted twice.
 */
export function useRequestSide(session: TreeSession): { ownerId: string; branch: string | null } {
  const host = useHost(session.hostId);
  return requestSideOf(session, (id) => (id === host?.id ? host : undefined));
}

/** Whose pull requests the session `sessionId` shows (`worktreeOwnerId`): its host for a guest, else itself. */
export function useRequestOwner(sessionId: string): string {
  return useApp((s) => {
    const row = s.sessionsById.get(sessionId);
    return row ? worktreeOwnerId(row) : sessionId;
  });
}
