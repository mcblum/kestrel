// What a drop in the sidebar does: a session, a group or a project dropped beside another row, or
// a pinned row dropped back into its list. Plain functions over the store, read at drop time, so the
// rows that call them (Sidebar.tsx) stay memoized. Moved out of Sidebar.tsx as it was (0.0.18).
import type { PinKind, SessionView, WorkspaceState } from '@kestrel/server/model';
import { isPinned } from '@kestrel/server/pins';
import { fitsGroup } from '@kestrel/server/project-groups';
import type { SessionOrder } from '@kestrel/server/session-order';
import { rootOf } from '@kestrel/server/tree';
import { GROUP_MIME, SESSION_MIME } from '../labels.ts';
import { openView } from '../route.ts';
import { actions, appStore } from '../store.ts';
import { sessionOrderOf, tabActions, tabsView } from '../tabsStore.ts';
import { draggingId } from './sidebarDrag.ts';

/** Every id the shared order of the Sessions list covers: groups and the top session of each tree. */
function orderedIds(ws: WorkspaceState): string[] {
  return [...ws.groups.map((g) => g.id), ...Object.values(ws.trees).flatMap((tree) => tree.map((n) => n.sessionId))];
}

/** A pinned row dropped into one of the lists leaves PINNED: that list is its home again. */
export function unpinIfPinned(kind: PinKind, id: string): void {
  const ws = appStore.get().workspace;
  if (ws && isPinned(ws.pins, kind, id)) void actions.setPinned(kind, id, false);
}

/**
 * A session was dropped beside `targetId` (a top-level session or a group), or at the end of the
 * list when there is none. It joins `groupId` if it was elsewhere, then takes that place. Linked
 * sessions move as one, so the place belongs to the top session of the dragged one's tree.
 */
export async function dropSession(draggedId: string, targetId: string | null, groupId: string | null | undefined, after: boolean): Promise<void> {
  const ws = appStore.get().workspace;
  const dragged = ws?.sessions.find((x) => x.id === draggedId);
  if (!ws || !dragged) return;
  const moving = rootOf(draggedId, ws.links);
  if (moving === targetId) return;
  unpinIfPinned('session', draggedId);
  if (groupId !== undefined && dragged.groupId !== groupId && !(await joinGroup(draggedId, groupId))) return;
  // Sorted by most recent, a place in the list means nothing: the dragged order is left as it was,
  // for when the user goes back to a custom order.
  if (sessionOrderNow() === 'custom') tabActions.placeInSidebar(orderedIds(ws), moving, targetId, after);
}

/**
 * Put a dropped session in `groupId` (null: no group). A project's group takes only that project's
 * sessions: any other is offered the Move page, which starts a new session in the project, in that
 * group, with its own worktree. False when it did not join here.
 */
export async function joinGroup(sessionId: string, groupId: string | null): Promise<boolean> {
  const ws = appStore.get().workspace;
  const session = ws?.sessions.find((x) => x.id === sessionId);
  const group = groupId ? ws?.groups.find((g) => g.id === groupId) : undefined;
  if (session && group?.projectId && !fitsGroup(group, session)) {
    openView({ kind: 'move', sessionId, projectId: group.projectId, groupId: group.id });
    return false;
  }
  await actions.moveSession(sessionId, groupId);
  return true;
}

/** The project the group being dragged belongs to: null in the Sessions list, undefined when no group is dragged. */
export function draggedGroupProject(): string | null | undefined {
  const id = draggingId(GROUP_MIME);
  const group = id ? appStore.get().workspace?.groups.find((g) => g.id === id) : undefined;
  return group ? (group.projectId ?? null) : undefined;
}

/** The session order chosen in Settings, read outside React (on drop). */
const sessionOrderNow = (): SessionOrder => sessionOrderOf(tabsView());

/**
 * Sorted by most recent, a list takes no drop of a session it already shows: there is no place in
 * it to move to. `here` says whether the dragged session lives in this list; a pinned one does not
 * (dropping it here sends it home). Drags that did not start in the sidebar are not known: taken.
 */
export function draggedSessionIsHere(here: (session: SessionView) => boolean): boolean {
  const id = draggingId(SESSION_MIME);
  const ws = appStore.get().workspace;
  const session = id ? appStore.get().sessionsById.get(id) : undefined;
  return !!session && !!ws && !isPinned(ws.pins, 'session', session.id) && here(session);
}

/**
 * A group was dropped beside `targetId` (a group or a top-level session), or at the end, in the
 * Sessions list (`project` null) or in a project's list. A Sessions-list group dropped in a project
 * moves into it, with its sessions (refused, with the reason, when one belongs elsewhere); a
 * project's group never leaves its project.
 */
export async function dropGroup(groupId: string, targetId: string | null, after: boolean, project: string | null = null): Promise<void> {
  const ws = appStore.get().workspace;
  const group = ws?.groups.find((g) => g.id === groupId);
  if (!ws || !group || groupId === targetId) return;
  const from = group.projectId ?? null;
  if (from !== project) {
    if (from !== null || project === null) return;
    if (!(await actions.moveGroupToProject(groupId, project))) return;
  }
  unpinIfPinned('group', groupId);
  tabActions.placeInSidebar(orderedIds(ws), groupId, targetId, after);
}

/** A project was dropped beside another project. */
export function dropProject(projectId: string, targetId: string, after: boolean): void {
  const ws = appStore.get().workspace;
  if (!ws || projectId === targetId || !ws.projects.some((p) => p.id === projectId)) return;
  unpinIfPinned('project', projectId);
  tabActions.placeProject(ws.projects.map((p) => p.id), projectId, targetId, after);
}
