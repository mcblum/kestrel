// The session record and the checks `Workspace` writes go through: new rows, inherited tags, tree limits.
import type { ReviewMark } from './shared/review-requests.ts';
import { randomUUID } from 'node:crypto';
import { limitMessage, type DelegationLimits } from './limits.ts';
import { Refused } from './refused.ts';
import { depthOf, rootOf, subtreeIds } from './tree.ts';
import type { Agent, Link, Project, Session, SessionState } from './model.ts';
import type { Persistence, StoredDetail } from './persistence/types.ts';

export interface NewSession {
  id?: string;
  title: string;
  agent: Agent;
  startedIn: string | null;
  startedFolderId?: string | null; // which of `startedIn`'s directories; null where it has none
  groupId?: string | null;
  state?: SessionState;
  note?: string;
  branch?: string | null;
  worktreePath?: string | null;
  landedIn?: string | null;
  /** A review of somebody else's request (shared/review-requests.ts). */
  review?: ReviewMark;
}

export interface DelegateTask {
  projectId: string;
  folderId?: string | null; // which of the project's directories; null where it has none
  brief: string;
  agent?: Agent;
  /** Short title for the child; defaults to the brief. */
  title?: string;
}

export const EMPTY_DETAIL: StoredDetail = { messages: [], files: [], agentOutput: '', kestrelTools: 'connected' };
export const LIVE: readonly SessionState[] = ['running', 'attention'];

/** Write a new session row, stamped with `now`. */
export async function insertSession(tx: Persistence, s: NewSession, now: number): Promise<Session> {
  const session: Session = {
    id: s.id ?? randomUUID(),
    title: s.title,
    agent: s.agent,
    state: s.state ?? 'running',
    note: s.note ?? '',
    startedIn: s.startedIn,
    startedFolderId: s.startedFolderId ?? null,
    landedIn: s.landedIn ?? null,
    worktreePath: s.worktreePath ?? null,
    branch: s.branch ?? null,
    worktreeDiscarded: false,
    groupId: s.groupId ?? null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...(s.review ? { review: s.review } : {}),
  };
  await tx.insertSession(session);
  return session;
}

/** A child starts with its parent's tags, copied: tagging the parent later does not reach it. */
export async function copyTags(tx: Persistence, fromId: string, toIds: readonly string[]): Promise<void> {
  const tags = await tx.tagsOf(fromId);
  if (tags.length > 0) for (const id of toIds) await tx.setTags(id, tags);
}

/** A project's name by id, for refusals; empty when there is none. */
export const projectNamer = (projects: readonly Project[]) => (id: string): string => projects.find((p) => p.id === id)?.name ?? '';

/** Refused when adding `adding` live sessions to the caller's tree would pass the live-session limit. */
export function checkLive(limits: DelegationLimits, callerId: string, adding: number, sessions: readonly Session[], links: readonly Link[]): void {
  const tree = new Set(subtreeIds(rootOf(callerId, links), links));
  const live = sessions.filter((s) => tree.has(s.id) && LIVE.includes(s.state)).length;
  if (live + adding > limits.maxLiveSessionsPerTree) throw new Refused(limitMessage.tooManyLive(limits, live));
}

/** The depth and live-session limits in force for children of `parentId`. */
export function checkLimits(limits: DelegationLimits, parentId: string, adding: number, sessions: readonly Session[], links: readonly Link[]): void {
  if (depthOf(parentId, links) + 1 > limits.maxDepth) throw new Refused(limitMessage.tooDeep(limits));
  checkLive(limits, parentId, adding, sessions, links);
}

/** Refused while a session inside what is being archived (the session, the group's, the project's) is still working. */
export function refuseWhileWorking(kind: 'session' | 'project' | 'group', id: string, sessions: readonly Session[]): void {
  const within = sessions.filter((s) => (kind === 'session' ? s.id === id : kind === 'group' ? s.groupId === id : s.startedIn === id || s.landedIn === id));
  const busy = within.filter((s) => LIVE.includes(s.state));
  if (busy.length > 0) throw new Refused(busy.length === 1 ? `"${busy[0]!.title}" is still working. Stop it before archiving.` : `${busy.length} sessions here are still working. Stop them before archiving.`);
}
