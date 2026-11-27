// Which context menu a sidebar row gets. One place for the right-click on a row and the row's …
// button, so the two always open the same menu (menu.ts holds the items themselves).
import { remoteWorkstreamRefusal } from '@kestrel/server/account-workstreams';
import { isArchived, isComplete, isOpenWork } from '@kestrel/server/workstreams';
import type { PinKind, WorkspaceState } from '@kestrel/server/model';
import { sidebarMenu, type MenuTarget } from '@kestrel/server/menu';
import { isPinned } from '@kestrel/server/pins';
import { hostTerms } from '@kestrel/server/host-terms';
import { fitsGroup } from '@kestrel/server/project-groups';
import { removeRefusal, workstreamOf } from '@kestrel/server/workstreams';
import type { Seen } from '@kestrel/server/unread';
import type { FolderApp } from '@kestrel/server/file-menu';
import { contextMenu } from '../menuState.ts';
import { heldFolderApps, loadFolderApps } from './folderApps.ts';
import { appStore } from '../store.ts';
import { projectPathOf } from './projectLabels.ts';
import { dotFor } from './useRowDot.ts';

/** What a row says about itself in `data-menu-kind`. */
export type RowKind = 'overview' | 'session' | 'folder' | 'project' | 'tag' | 'workstream';

const busy = isOpenWork;
/** The apps a session's or project's folder can be opened in, once the server has said (folderApps.ts). */
const openIn = (): { openIn?: { apps: readonly FolderApp[]; defaultId: string | null } } => {
  const held = heldFolderApps();
  return held ? { openIn: { apps: held.apps, defaultId: held.defaultApp } } : {};
};

/** Only the Mac app can show a folder in Finder; the browser build offers Copy path alone. */
const canReveal = () => Boolean(window.kestrelShell?.reveal);

function sessionTarget(ws: WorkspaceState, id: string, seen: Seen | null, pinned: boolean): MenuTarget {
  const s = ws.sessions.find((x) => x.id === id);
  if (!s) return { kind: 'empty' };
  const elsewhere = ws.projects.filter((p) => !p.away && p.id !== (s.landedIn ?? s.startedIn));
  // Archived ones too: a session can be taken out of a workstream that is put away.
  const workstream = workstreamOf([...ws.workstreams, ...ws.archivedWorkstreams], id);
  return {
    kind: 'session',
    sessionId: id,
    agent: s.agent,
    running: busy(s),
    groupId: s.groupId,
    branch: s.branch,
    path: s.worktreePath,
    unread: seen ? dotFor(s, seen) === 'unread' : undefined,
    // Only groups it may join: a project's group takes only that project's sessions.
    groups: ws.groups.filter((g) => fitsGroup(g, s)).map((g) => ({ id: g.id, name: g.name })),
    projects: elsewhere.map((p) => ({ id: p.id, name: p.name })),
    pinned,
    canReveal: canReveal(),
    ...openIn(),
    ...(workstream ? { workstream: { id: workstream.id, name: workstream.name, refusal: remoteWorkstreamRefusal(workstream) ?? removeRefusal(workstream, s.id) } } : {}),
  };
}

function projectTarget(ws: WorkspaceState, id: string, pinned: boolean): MenuTarget {
  const inProject = (x: { startedIn: string | null; landedIn: string | null }) => x.startedIn === id || x.landedIn === id;
  const live = ws.sessions.filter(inProject);
  const sessionCount = live.length + ws.archived.sessions.filter(inProject).length;
  const project = ws.projects.find((p) => p.id === id);
  return { kind: 'project', projectId: id, name: project?.name ?? 'this project', sessionCount, path: projectPathOf(project), running: live.some(busy), pinned, canReveal: canReveal(), ...openIn(), ...(project?.away ? { away: true } : {}) };
}

/** Opened from the item's own page header, the menu has no way to that page. */
function withPlace(target: MenuTarget, onPage: boolean): MenuTarget {
  if (onPage && target.kind === 'ticket') return { ...target, details: false };
  return onPage && (target.kind === 'project' || target.kind === 'folder' || target.kind === 'workstream') ? { ...target, onPage } : target;
}

/** The menu target for the row of `kind` and `id`; anything else is the sidebar's empty space. */
export function menuTargetFor(ws: WorkspaceState, kind: string | undefined, id: string, seen: Seen | null): MenuTarget {
  const pinned = (pinKind: PinKind) => isPinned(ws.pins, pinKind, id);
  if (kind === 'overview') return { kind: 'overview' };
  if (kind === 'pinned') return { kind: 'pinned' };
  if (kind === 'session') return sessionTarget(ws, id, seen, pinned('session'));
  if (kind === 'project') return projectTarget(ws, id, pinned('project'));
  if (kind === 'tag') return { kind: 'tag', tag: id };
  if (kind === 'review') {
    const held = appStore.get().reviewRequests;
    const waiting = held.requests.find((r) => r.key === id);
    const request = waiting ?? held.dismissed.find((r) => r.key === id);
    const sessionId = ws.sessions.find((s) => s.review?.key === id)?.id;
    return {
      kind: 'review',
      key: id,
      pinned: pinned('review'),
      unread: held.unread.includes(id),
      ...(request && !waiting ? { dismissed: true } : {}),
      ...(request?.url ? { url: request.url, service: hostTerms(request.host).service } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }
  if (kind === 'ticket') {
    const held = appStore.get().tickets;
    const closed = held.closed.some((t) => t.key === id);
    const dismissed = held.dismissed.some((t) => t.key === id);
    const ticket = held.tickets.find((t) => t.key === id) ?? held.dismissed.find((t) => t.key === id) ?? held.closed.find((t) => t.key === id);
    if (!ticket) return { kind: 'empty' };
    return {
      kind: 'ticket',
      key: id,
      // A closed ticket has no read state and is not dismissed or restored.
      ...(closed ? { canDismiss: false } : { unread: held.unread.includes(id) }),
      ...(dismissed ? { dismissed: true } : {}),
      ...(ticket.url ? { url: ticket.url, tracker: ticket.tracker } : {}),
    };
  }
  if (kind === 'workstream') {
    const workstream = ws.workstreams.find((w) => w.id === id) ?? ws.archivedWorkstreams.find((w) => w.id === id);
    if (!workstream) return { kind: 'empty' };
    const members = new Set(workstream.sessionIds);
    const inSight = ws.sessions.filter((s) => members.has(s.id));
    return { kind: 'workstream', workstreamId: id, name: workstream.name, running: inSight.some(busy), members: inSight, complete: isComplete(workstream), archived: isArchived(workstream), elsewhere: remoteWorkstreamRefusal(workstream) };
  }
  if (kind === 'folder') {
    const inFolder = ws.sessions.filter((x) => x.groupId === id);
    const group = ws.groups.find((g) => g.id === id);
    const projectId = group?.projectId ?? null;
    // A project's group stays in its project; a Sessions-list group may move into any project.
    const where = projectId ? { projectId } : { projects: ws.projects.filter((p) => !p.away).map((p) => ({ id: p.id, name: p.name })) };
    return { kind: 'folder', groupId: id, name: group?.name ?? 'this group', sessionCount: inFolder.length, running: inFolder.some(busy), pinned: pinned('group'), ...where };
  }
  return { kind: 'empty' };
}

/** Where a row's menu opens: at a right-click's point, or from its … button. */
export type RowMenuAt = { x: number; y: number } | { from: Element; gap: number; returnFocus?: HTMLElement };

/** Open the menu of a row; `onPage` when opened from that item's own page. */
export function openRowMenu(kind: string | undefined, id: string, at: RowMenuAt, onPage = false): void {
  const show = () => {
    const ws = appStore.get().workspace;
    if (!ws) return;
    const items = sidebarMenu(withPlace(menuTargetFor(ws, kind, id, appStore.get().seen), onPage));
    if ('from' in at) contextMenu.openFrom(at.from, items, { gap: at.gap, returnFocus: at.returnFocus });
    else contextMenu.open(at.x, at.y, items);
  };
  // The first menu asks which apps can open a folder (a local answer, held from then on) so it
  // can offer Open in; if that cannot be had, the menu opens without it.
  if (kind === 'review' || kind === 'ticket' || heldFolderApps()) show();
  else void loadFolderApps().then(show, show);
}
