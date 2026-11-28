// Keeps the PR store (pull-requests/store.ts) filled for every session in sight, so a window has
// every session's pull requests the moment it connects and never waits on gh or glab to show them.
//   - Every CHECK_MS, and soon after the workspace changes: each session in sight that is new to the
//     store, or changed since the last check (`updatedAt`), is looked up through `sessionLookup`. That
//     reads its branch and links, which is cheap, and asks the host only when they changed.
//   - A session whose turn just ended is asked about at once: a turn is where a pull request gets
//     opened ("Pushed and opened: ..."), and while none is linked the store asks only every three
//     minutes, so the Create button stayed up long after the agent had opened one.
//   - Sessions no longer in sight are forgotten.
//   - While some window is connected, the store asks again about the sessions whose time has come.
//     A session a window has open comes round every few seconds (WATCHED_POLL_MS), so its header keeps up.
//     A session Autopilot `kept` (a round opening a new request after a merge) is asked soon though merged.
import { sessionLookup, type DetailsSources } from './details-api.ts';
import { LOOKUP_CONCURRENCY, mapLimited } from './pull-request-list-api.ts';
import type { SessionState } from './model.ts';
import type { Workspace } from './workspace.ts';

export const CHECK_MS = 5_000;
/** How soon after a workspace change the sessions are checked: changes come in bursts. */
export const CHANGE_DELAY_MS = 500;

export interface PullRequestSync {
  /** Check now (tests), and wait for it. */
  check(): Promise<void>;
  stop(): void;
}

export function syncPullRequests(workspace: Workspace, sources: DetailsSources, sample: boolean, watched: () => boolean, watching: (sessionId: string) => boolean = () => false, kept: (sessionId: string) => boolean = () => false): PullRequestSync {
  const seen = new Map<string, { updatedAt: number; state: SessionState }>();
  let running: Promise<void> | null = null;
  let again = false;

  const once = async () => {
    const state = await workspace.state();
    const inSight = new Set(state.sessions.map((s) => s.id));
    for (const id of sources.store.ids()) if (!inSight.has(id)) sources.store.forget(id);
    for (const id of seen.keys()) if (!inSight.has(id)) seen.delete(id);
    // The state as well as the time: two changes in one millisecond carry the same `updatedAt`.
    const changed = state.sessions.filter((s) => seen.get(s.id)?.updatedAt !== s.updatedAt || seen.get(s.id)?.state !== s.state);
    await mapLimited(changed, LOOKUP_CONCURRENCY, async (session) => {
      const turnEnded = seen.get(session.id)?.state === 'running' && session.state !== 'running';
      await sessionLookup(state, session, workspace, sources, turnEnded, sample).catch(() => undefined);
      seen.set(session.id, { updatedAt: session.updatedAt, state: session.state });
    });
    if (watched()) await sources.store.tick(watching, kept);
  };

  const check = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = once()
      .catch((error: unknown) => console.error('[kestrel] could not check pull requests', error))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void check();
        }
      });
    return running;
  };

  let soon: NodeJS.Timeout | null = null;
  const unsubscribe = workspace.onChange(() => {
    soon ??= setTimeout(() => {
      soon = null;
      void check();
    }, CHANGE_DELAY_MS);
  });
  const timer = setInterval(() => void check(), CHECK_MS);
  void check();

  return {
    check,
    stop: () => {
      clearInterval(timer);
      if (soon) clearTimeout(soon);
      unsubscribe();
    },
  };
}
