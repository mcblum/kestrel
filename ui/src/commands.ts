// Things the user can do from a shortcut, a menu, or the Electron app menu. One place, so the
// page and the native menu can never disagree.
import { bindingOf, commandFor, browserNavCommand } from '@kestrel/server/shortcuts';
import { goBack, goForward } from './navHistory.ts';
import { isMac, shortcuts } from './shortcuts.ts';
import { openCreateProject, openProjectFolders, openProjectPage, openProjectSettings } from './projectNav.ts';
import type { MenuAction } from '@kestrel/server/menu';
import { scopeOfActive, type Controls, type Scope } from '@kestrel/server/tabs';
import { currentRoute, openSession, openView } from './route.ts';
import { appStore, actions } from './store.ts';
import { tabActions, tabsView } from './tabsStore.ts';
import { revealSidebar, toggleSidebarOrFloat } from './sidebarRail.ts';
import { markCopied } from './copied.ts';
import { focusAtEnd } from './components/messageInputDom.ts';
import { setupOpenNow } from './onboarding/data.ts';
import { setSessionAutopilot } from './autopilotPrefs.ts';

/**
 * Show the New session screen. A plain call shows it in the tab in front (or focuses the unsent one
 * already open); `newTab` gives it a tab of its own. A project or folder named by the entry point
 * is applied to the screen; with none named it inherits where the user is: the project or folder
 * page shown, or the project of the session tab in front. The Unscoped page means no project.
 * Otherwise the last session's choices stand.
 */
export function openNewSession(scope: Scope = {}, newTab = false, pinned = false): void {
  const named = scope.projectId || scope.groupId ? scope : null;
  tabActions.openNew({ ...(named ?? inheritedScope()), ...(pinned ? { pinned: true } : {}) }, named ?? {}, newTab);
  focusComposer();
}

function inheritedScope(): Partial<Controls> {
  const view = currentRoute().view;
  const page: Scope = view.kind === 'project' ? { projectId: view.id } : view.kind === 'group' ? { groupId: view.id } : {};
  const state = tabsView().state;
  const inherited: Partial<Controls> = scopeOfActive(state, page, appStore.get().workspace?.sessions ?? []);
  const onUnscopedPage = state.tabs.find((t) => t.id === state.activeId)?.kind === 'page' && view.kind === 'unscoped';
  return onUnscopedPage && !inherited.projectId ? { ...inherited, projectId: null } : inherited;
}

/** Put the cursor in the New session message box, which may already be on screen. */
function focusComposer(): void {
  requestAnimationFrame(() => focusAtEnd(document.querySelector<HTMLElement>('.new-session .composer-input')));
}

/** How many frames to wait for a session just made to be drawn (about two seconds). */
const FRAMES_TO_WAIT_FOR_SESSION = 120;

/** Put the cursor in a session's message box once that session is on screen (it may arrive with the next server push). */
function focusSessionComposer(sessionId: string, framesLeft = FRAMES_TO_WAIT_FOR_SESSION): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLElement>(`.session-workspace[data-session-id="${CSS.escape(sessionId)}"] .composer-dock .composer-input`);
    if (input) focusAtEnd(input);
    else if (framesLeft > 0) focusSessionComposer(sessionId, framesLeft - 1);
  });
}

/** Fork a session and open the fork, ready to type in. A refusal shows its reason (store `act`). */
async function forkAndOpen(sessionId: string, turn: string | undefined, newTab: boolean): Promise<void> {
  const fork = await actions.forkSession(sessionId, turn);
  if (!fork) return;
  // The fork is not in the pushed workspace yet; without this its tab is pruned as a missing session.
  tabActions.expect(fork.id);
  openSession(fork.id, newTab);
  focusSessionComposer(fork.id);
}

export type Command = 'new-session' | 'new-tab' | 'close-tab' | 'switch' | 'next-tab' | 'prev-tab' | 'toggle-sidebar' | 'back' | 'forward' | 'whats-new' | `tab:${number}`;

/** Opened by the shell (Electron menu) or by a key press; App provides the switcher. */
let openSwitcher: () => void = () => undefined;
/** Open a project's list in the sidebar (its open state is kept as `open:<id>`, sidebar.ts). */
function openProjectInSidebar(projectId: string): void {
  const key = `open:${projectId}`;
  if (!tabsView().sidebar.collapsed.includes(key)) tabActions.toggleCollapsed(key);
}

/** A New group on its way to the server; a second press meanwhile is ignored. */
let creatingGroup = false;
export const setSwitcherOpener = (fn: () => void) => {
  openSwitcher = fn;
};

/**
 * One of the app's commands, from a key press or from Electron's app menu. While setup is under way
 * (it takes the whole window) they wait: nothing runs until it is finished or skipped, so no tab is
 * opened behind it. The browser's and the system's own shortcuts are not commands and are untouched.
 */
export function runCommand(command: Command | string): void {
  if (setupOpenNow()) return;
  if (command === 'new-session') openNewSession();
  else if (command === 'new-tab') openNewSession({}, true);
  else if (command === 'close-tab') tabActions.closeActive();
  else if (command === 'switch') openSwitcher();
  else if (command === 'next-tab') tabActions.step(1);
  else if (command === 'prev-tab') tabActions.step(-1);
  else if (command === 'toggle-sidebar') toggleSidebarOrFloat();
  else if (command === 'back') goBack();
  else if (command === 'forward') goForward();
  else if (command === 'whats-new') openView({ kind: 'whats-new' });
  else if (command.startsWith('tab:')) tabActions.activateNth(Number(command.slice(4)));
}

/** Map a key press to a command, or null: the user's keys over the defaults (shared/shortcuts.ts). Cmd on Mac, Ctrl elsewhere. */
export function commandForKey(event: KeyboardEvent): string | null {
  const binding = bindingOf(event, isMac());
  return commandFor(shortcuts(), binding) ?? browserNavCommand(binding, isMac());
}

/**
 * Run one sidebar menu action. The menu and the "+" buttons both end up here. `newTab` (shift,
 * Cmd or middle click) opens what the action shows in a tab of its own.
 */
export async function runMenuAction(action: MenuAction, newTab = false): Promise<void> {
  switch (action.type) {
    case 'new-session':
      openNewSession({ ...(action.projectId ? { projectId: action.projectId } : {}), ...(action.groupId ? { groupId: action.groupId } : {}) }, newTab, action.pinned === true);
      return;
    case 'open-project':
      openProjectPage(action.projectId, newTab);
      return;
    case 'project-settings':
      openProjectSettings(action.projectId, undefined, newTab);
      return;
    case 'open-group':
      openView({ kind: 'group', id: action.groupId }, newTab);
      return;
    case 'open-tag':
      openView({ kind: 'tag', id: action.tag }, newTab);
      return;
    case 'rename':
      // Named in its own sidebar row, not in a dialog; from a page's … menu the sidebar may be hidden or a rail.
      revealSidebar();
      actions.startRename(action.id);
      return;
    case 'fork-session':
      await forkAndOpen(action.sessionId, action.turn, newTab);
      return;
    case 'tag-session':
      openSession(action.sessionId, newTab); // the tag box is in the session's Details pane, which this opens
      actions.startTagging(action.sessionId);
      return;
    case 'archive':
      await actions.archive(action.kind, action.id);
      return;
    case 'pin':
      await actions.setPinned(action.kind, action.id, action.pinned);
      return;
    case 'open-review':
      if (action.sessionId) openSession(action.sessionId, newTab);
      else openView({ kind: 'review-request', id: action.key }, newTab);
      return;
    case 'open-link':
      window.open(action.url, '_blank', 'noreferrer');
      return;
    case 'mark-review-read':
      await actions.markReviewsSeen([action.key], action.read, true);
      return;
    case 'mark-ticket-read':
      await actions.markTicketsSeen([action.key], action.read, true);
      return;
    case 'dismiss-ticket':
      await actions.dismissTickets([action.key], action.dismissed);
      return;
    case 'open-ticket':
      openView({ kind: 'ticket', id: action.key });
      return;
    case 'dismiss-review':
      await actions.dismissReviews([action.key], action.dismissed);
      return;
    case 'delete-session': {
      const session = appStore.get().sessionsById.get(action.sessionId);
      if (session) actions.deleteSession(session);
      return;
    }
    case 'mark-unread':
      tabActions.setUnread(action.sessionId, action.unread);
      return;
    case 'set-autopilot':
      await setSessionAutopilot(action.sessionId, { on: action.on, ...(action.merge === undefined ? {} : { merge: action.merge }) });
      return;
    case 'reveal':
      await actions.reveal(action.path);
      return;
    case 'copy':
      await navigator.clipboard.writeText(action.text).then(() => action.key && markCopied(action.key), () => undefined);
      return;
    case 'new-folder': {
      // One at a time: a second press while the first is on its way would make a second group.
      if (creatingGroup) return;
      creatingGroup = true;
      try {
        const taken = new Set(appStore.get().workspace?.groups.map((g) => g.name));
        let name = 'New group';
        for (let n = 2; taken.has(name); n++) name = `New group ${n}`;
        const created = await actions.createGroup(name, action.projectId);
        if (!created) return;
        // A project's new group shows only under an open project: open it, then name it in its row.
        if (action.projectId) openProjectInSidebar(action.projectId);
        actions.startRename(created.id);
      } finally {
        creatingGroup = false;
      }
      return;
    }
    case 'move-group-to-project':
      // Show where it went: it is drawn under the project, so the project opens.
      if (await actions.moveGroupToProject(action.groupId, action.projectId)) openProjectInSidebar(action.projectId);
      return;
    case 'add-project':
      openCreateProject(newTab);
      return;
    case 'add-folder':
      openProjectFolders(action.projectId, newTab);
      return;
    case 'remove-project':
      {
        const project = appStore.get().workspace?.projects.find((p) => p.id === action.projectId);
        if (project && window.confirm(`Remove “${project.name}” from Kestrel? The folder on disk is not touched.`)) await actions.removeProject(action.projectId);
      }
      return;
    case 'rename-folder':
      revealSidebar();
      actions.startRename(action.groupId);
      return;
    case 'delete-folder': {
      const ws = appStore.get().workspace;
      const group = ws?.groups.find((g) => g.id === action.groupId);
      if (group && ws) actions.deleteFolder(group, ws.sessions.filter((s) => s.groupId === group.id).length);
      return;
    }
    case 'open-new-tab': {
      const open = action.item;
      if (open.kind === 'session') openSession(open.id, true);
      else openView(open.kind === 'overview' ? { kind: 'overview' } : { kind: open.kind, id: open.id }, true);
      return;
    }
    case 'move-session':
      await actions.moveSession(action.sessionId, action.groupId);
      return;
    case 'stop-session':
      await actions.stop(action.sessionId);
      return;
    case 'move-to-project':
      openView({ kind: 'move', sessionId: action.sessionId, projectId: action.projectId }, newTab);
      return;
    case 'stop-folder':
      await actions.stopFolder(action.groupId);
      return;
    case 'open-workstream':
      openView({ kind: 'workstream', id: action.workstreamId }, newTab);
      return;
    case 'rename-workstream':
      // Named in its own sidebar row, as a group is.
      revealSidebar();
      actions.startRename(action.workstreamId);
      return;
    case 'set-workstream-status':
      await actions.setWorkstreamStatus(action.workstreamId, action.status);
      return;
    case 'archive-workstream':
      if (action.withSessions && action.archived) await actions.archiveWorkstreamAndSessions(action.workstreamId);
      else await actions.archiveWorkstream(action.workstreamId, action.archived, action.withSessions === true);
      return;
    case 'stop-workstream':
      await actions.stopWorkstream(action.workstreamId);
      return;
    case 'delete-workstream': {
      const workstream = appStore.get().workspace?.workstreams.find((w) => w.id === action.workstreamId);
      if (workstream && action.withSessions) void actions.deleteWorkstreamAndSessions(workstream);
      else if (workstream) actions.deleteWorkstream(workstream);
      return;
    }
    case 'retry-command':
      await actions.retryCommand(action.sessionId, action.commandId);
      return;
    case 'open-folder':
      await actions.openFolder(action.scope, action.appId);
      return;
    case 'stop-command':
      await actions.stopCommandFromMenu(action.sessionId, action.commandId);
      return;
    case 'copy-command-output': {
      // Asked for now: the menu never carries a command's output. Nothing is copied when it cannot be had.
      const output = await actions.commandOutput(action.sessionId, action.commandId).catch(() => null);
      if (output) await navigator.clipboard.writeText(output.text).catch(() => undefined);
      return;
    }
    case 'remove-from-workstream':
      await actions.removeFromWorkstream(action.workstreamId, action.sessionId);
      return;
  }
}
