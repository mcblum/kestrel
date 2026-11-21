// A session's worktree, thrown away (worktree-landing.ts):
//   POST /api/sessions/:id/discard-preview         what discarding the worktree would lose
//   POST /api/sessions/:id/discard {deleteBranch}  remove the worktree (and the branch)
// Refusals carry their reason (409, via http.ts); a bad body is a 400.
import type { SessionRuntime } from './runtime.ts';

import { previewDiscard } from './worktree-landing.ts';
import { isBulkRemoval } from './shared/stale-worktrees.ts';

const ACTIONS = ['discard-preview', 'discard'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (value: string | undefined): value is Action => (ACTIONS as readonly string[]).includes(value ?? '');
type Answer = { status: number; body?: unknown };

/**
 * Settings → Worktrees and the Overview's line (worktree-cleanup.ts):
 *   GET  /api/worktrees                    every session worktree on disk, its size, and whether it looks stale
 *   POST /api/worktrees/remove { which }   remove several: "safe" (the ones that lose nothing) or "stale"
 *                                          (every suggested one); { removed, failed }
 * Null when the request is not one of these.
 */
export async function worktreesRoute(parts: readonly string[], method: string, refresh: boolean, read: () => Promise<Record<string, unknown>>, runtime: Pick<SessionRuntime, 'worktrees' | 'removeWorktrees'> | null): Promise<Answer | null> {
  if (parts[1] !== 'worktrees') return null;
  if (method === 'GET' && parts.length === 2) return { status: 200, body: runtime ? await runtime.worktrees(refresh) : { rows: [], summary: { stale: { count: 0, bytes: 0 }, safe: { count: 0, bytes: 0 } } } };
  if (method === 'POST' && parts.length === 3 && parts[2] === 'remove') {
    if (!runtime) return { status: 400, body: { error: 'Worktrees cannot be removed without the session runtime.' } };
    const which = (await read()).which;
    if (!isBulkRemoval(which)) return { status: 400, body: { error: 'which must be "safe" or "stale"' } };
    return { status: 200, body: await runtime.removeWorktrees(which) };
  }
  return null;
}

/** Null when the request is not one of these routes. */
export async function landingRoute(parts: readonly string[], method: string, read: () => Promise<Record<string, unknown>>, runtime: Pick<SessionRuntime, 'checkoutOf' | 'discardWorktree'> | null): Promise<Answer | null> {
  const action = parts[3];
  if (method !== 'POST' || parts.length !== 4 || parts[1] !== 'sessions' || !isAction(action)) return null;
  if (!runtime) return { status: 400, body: { error: 'Worktrees cannot be discarded without the session runtime.' } };
  const id = parts[2]!;
  if (action === 'discard') {
    const body = await read();
    if (body.deleteBranch !== undefined && typeof body.deleteBranch !== 'boolean') return { status: 400, body: { error: 'deleteBranch must be true or false' } };
    await runtime.discardWorktree(id, body.deleteBranch === true);
    return { status: 204 };
  }
  const { checkout, worktree, branch } = await runtime.checkoutOf(id);
  return { status: 200, body: await previewDiscard(checkout, worktree, branch) };
}


