// Waits between sessions of a workstream (GitLab issue 3): "App A is waiting for App B's endpoint".
// The waiting session's agent declares its own wait with `wait_for`, with a short reason; it ends
// when the session waited on finishes (the waiter is told, as an orchestrator is about its
// delegates), or when that agent clears it. Pure: the server keeps them, the workstream page draws
// them. An orchestrator waiting on the sessions it delegated to is not declared: it is read from
// the links (`waitingOn`), and `waitsIn` shows both in one list.
import type { Link, Session, SessionWait, Workstream } from '../model.ts';
import { isOpenWork, waitingOn, workstreamOf } from './workstreams.ts';

/** How long a wait's reason may be: a few words, shown on one line of the workstream page. */
export const WAIT_REASON_MAX = 200;

type Member = Pick<Session, 'id' | 'title' | 'state' | 'turnByUser'>;
type Members = Pick<Workstream, 'id' | 'sessionIds'>;

export type WaitCheck = { ok: true; workstreamId: string; reason: string } | { ok: false; reason: string; /** The target already finished: the caller is given its last message too. */ finished?: true };

const named = (s: Pick<Session, 'id' | 'title'>) => `“${s.title}” (${s.id})`;

/**
 * The chain of waits that `waiterId` waiting on `targetId` would close, as session ids from the
 * waiter round to itself ([waiter, target, …, waiter]); null when it closes none. Only declared
 * waits count: an orchestrator is not blocked by its delegates, it is told when they finish.
 */
export function waitCycle(waits: readonly Pick<SessionWait, 'waiterId' | 'targetId'>[], waiterId: string, targetId: string): string[] | null {
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === waiterId) return path;
    if (seen.has(at)) return null;
    seen.add(at);
    for (const w of waits) {
      if (w.waiterId !== at || (w.waiterId === waiterId && w.targetId === targetId)) continue;
      const found = walk(w.targetId, [...path, w.targetId]);
      if (found) return found;
    }
    return null;
  };
  return walk(targetId, [waiterId, targetId]);
}

/**
 * Whether the session `waiterId` may wait on `targetId`, and why not. Workstreams archived or not
 * count: archiving is visibility only. Declaring again on the same target replaces the reason.
 */
export function checkWait(args: { waiterId: string; targetId: string; reason: string; workstreams: readonly (Members & Pick<Workstream, 'name'>)[]; sessions: readonly Member[]; waits: readonly SessionWait[] }): WaitCheck {
  const { waiterId, targetId, sessions } = args;
  const reason = args.reason.trim();
  const workstream = workstreamOf(args.workstreams, waiterId);
  if (!workstream) return { ok: false, reason: 'This session is not in a workstream, so there is no other session in it to wait on. Use session_status for the sessions you started.' };
  if (targetId === waiterId) return { ok: false, reason: 'That is this session: you cannot wait on yourself.' };
  const target = workstream.sessionIds.includes(targetId) ? sessions.find((s) => s.id === targetId) : undefined;
  if (!target) {
    const others = workstream.sessionIds.flatMap((id) => (id === waiterId ? [] : sessions.filter((s) => s.id === id)));
    return { ok: false, reason: `${targetId} is not in “${workstream.name}”. You can wait on a session in it: ${others.map(named).join(', ') || 'there is no other'}.` };
  }
  if (!isOpenWork(target)) return { ok: false, finished: true, reason: `${named(target)} has already finished, so there is nothing to wait for.` };
  if (!reason) return { ok: false, reason: 'Say in a few words what you are waiting for (reason).' };
  if (reason.length > WAIT_REASON_MAX) return { ok: false, reason: `The reason is ${reason.length} characters; keep it to ${WAIT_REASON_MAX} (a few words, shown on one line).` };
  const cycle = waitCycle(args.waits, waiterId, targetId);
  if (cycle) {
    const title = (id: string) => `“${sessions.find((s) => s.id === id)?.title ?? id}”`;
    return { ok: false, reason: `Waiting on ${named(target)} would close a loop of sessions waiting on each other: ${cycle.map(title).join(' → ')}. Do the part you can, or tell the user what is blocked.` };
  }
  return { ok: true, workstreamId: workstream.id, reason };
}

/** The waits on one session, which end when it finishes. */
export const waitsOnTarget = (waits: readonly SessionWait[], targetId: string): SessionWait[] => waits.filter((w) => w.targetId === targetId);

/** The waits to send with the workspace state: in a workstream in sight, between two of its sessions in sight. */
export function visibleWaits(waits: readonly SessionWait[], workstreams: readonly Members[]): SessionWait[] {
  return waits.filter((w) => workstreams.some((ws) => ws.id === w.workstreamId && ws.sessionIds.includes(w.waiterId) && ws.sessionIds.includes(w.targetId)));
}

export type ShownWait = { kind: 'started'; waiterId: string; count: number } | { kind: 'declared'; waiterId: string; targetId: string; reason: string };

/**
 * Every wait to show for a workstream, in one list: sessions waiting on sessions they delegated
 * to (from the links, `waitingOn`), then the waits agents declared. The workstream page reads this.
 */
export function waitsIn(workstream: Members, members: readonly Member[], links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[], waits: readonly SessionWait[]): ShownWait[] {
  const started = waitingOn(members, links).map((w): ShownWait => ({ kind: 'started', waiterId: w.sessionId, count: w.count }));
  const declared = visibleWaits(waits, [workstream]).map((w): ShownWait => ({ kind: 'declared', waiterId: w.waiterId, targetId: w.targetId, reason: w.reason }));
  return [...started, ...declared];
}
