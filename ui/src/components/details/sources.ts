// The Details sources for one session (git status, pull requests, usage, the repository link), each
// with its own three states and each held once in the app store. Pull requests are pushed by the
// server's PR store, which keeps them current itself; the UI never asks for them on a timer. A sidebar
// row's change counts (shared/row-slot.ts) are asked again slowly while the window is visible.
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { isChangeCounts, isGitStatus, isSessionUsage } from '@kestrel/server/details';
import { LOADING, type Sourced } from '@kestrel/server/sourced';
import type { PullRequestLookup } from '@kestrel/server/details';
import { applyPullRequests, call, useApp } from '../../store.ts';
import { SIDEBAR_CHANGES_POLL_MS } from '@kestrel/server/row-slot';
import { useSourced } from './useSourced.ts';
import { useRequestOwner } from '../../workingTree.ts';

const sessionPath = (id: string, section: string) => `/api/sessions/${encodeURIComponent(id)}/${section}`;

export const useGitStatus = (sessionId: string, refreshKey: string) => useSourced(sessionPath(sessionId, 'git'), isGitStatus, refreshKey);
/** Moves `setTick` on every `pollMs` while the window is visible (never when null), and whenever it gains focus. */
export function useAskAgain(pollMs: number | null, setTick: Dispatch<SetStateAction<number>>): void {
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') setTick((t) => t + 1); };
    const timer = pollMs === null ? undefined : window.setInterval(update, pollMs);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [pollMs, setTick]);
}

/**
 * A session's pull requests, from the store (pushed by the server): a guest's are its host's. Refresh asks the server to ask
 * the host now; its answer comes back on the same push, and also straight from this call.
 */
export function usePullRequests(sessionId: string): { value: Sourced<PullRequestLookup>; refresh: () => void } {
  // A guest shows its host's requests, held once under the host (@kestrel/server/working-tree).
  const ownerId = useRequestOwner(sessionId);
  const value = useApp((s) => s.pullRequests.get(ownerId)) ?? LOADING;
  const refresh = useCallback(() => {
    call<unknown>(`${sessionPath(ownerId, 'pull-requests')}?refresh=1`).then(
      (raw) => applyPullRequests({ changes: { [ownerId]: raw } }),
      () => undefined,
    );
  }, [ownerId]);
  return { value, refresh };
}

/** How many files a session changed and how many are uncommitted: what its sidebar row's changes icon says. */
export function useChangeCounts(sessionId: string, refreshKey: string) {
  const [tick, setTick] = useState(0);
  const source = useSourced(sessionPath(sessionId, 'change-counts'), isChangeCounts, `${refreshKey}:${tick}`);
  useAskAgain(SIDEBAR_CHANGES_POLL_MS, setTick);
  return source;
}
export const useUsage = (sessionId: string, refreshKey: string) => useSourced(sessionPath(sessionId, 'usage'), isSessionUsage, refreshKey);

/** Changes whenever the session or its changes do, so the sources are asked again then (and only then). */
export const detailsRefreshKey = (updatedAt: number, diffs: readonly { diff: string }[]) => `${updatedAt}:${diffs.length}:${diffs.reduce((n, f) => n + f.diff.length, 0)}`;

/** A sanitized web URL from the repository's origin, independent of PR-provider support. */
const isRepositoryUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);
export const useRepository = (sessionId: string, refreshKey: string) => useSourced(sessionPath(sessionId, 'repository'), isRepositoryUrl, refreshKey);
