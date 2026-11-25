// The sidebar's context menu, as data. One definition feeds the right-click menu and the "+"
// buttons, so they can never disagree about what exists or what it is called.
import { archiveRefusal } from './workstreams.ts';
import { showInFileManager } from './platform.ts';

/** The id of every "Show in Finder" item, so the page can word it for its platform. */
export const REVEAL_ID = 'reveal';
import { openInMenu, type FolderApp } from './file-menu.ts';
import { forkRefusal } from './fork.ts';
import type { TurnFork } from './turns.ts';
import { scopeKey, type Scope } from './scope.ts';
import type { Agent, Session } from '../model.ts';

/**
 * Archive workstream, and Archive (or Delete) workstream and sessions, the full clean-up when the work
 * is done (Matt, 2026-11-22): disabled, with the reason, while any of its sessions is still at work.
 */
function cleanUpItems(name: string, workstreamId: string, members: readonly Pick<Session, 'id' | 'title' | 'state'>[]): MenuItem[] {
  const refusal = archiveRefusal({ name, sessionIds: members.map((s) => s.id) }, members);
  const item = (id: string, label: string, action: MenuAction, separatorBefore = false): MenuItem =>
    refusal ? { id, label, disabled: true, hint: refusal, separatorBefore } : { id, label, action, separatorBefore };
  return [
    item('archive-workstream', 'Archive workstream', { type: 'archive-workstream', workstreamId, archived: true }),
    item('archive-workstream-all', 'Archive workstream and sessions', { type: 'archive-workstream', workstreamId, archived: true, withSessions: true }),
    { id: 'delete-workstream', label: 'Delete workstream', action: { type: 'delete-workstream', workstreamId }, separatorBefore: true },
    item('delete-workstream-all', 'Delete workstream and sessions', { type: 'delete-workstream', workstreamId, withSessions: true }),
  ];
}

export type MenuAction =
  | { type: 'new-session'; projectId?: string; groupId?: string; /** Pin it as soon as it exists. */ pinned?: boolean }
  /** A new group: in the Sessions list, or in a project when `projectId` is given. */
  | { type: 'new-folder'; projectId?: string }
  | { type: 'open-project'; projectId: string }
  | { type: 'add-project' }
  | { type: 'remove-project'; projectId: string }
  | { type: 'open-group'; groupId: string }
  /** The page of every session with a tag. */
  | { type: 'open-tag'; tag: string }
  /** Go to the project page's list of directories, to add one. */
  | { type: 'add-folder'; projectId: string }
  /** The project's settings page. */
  | { type: 'project-settings'; projectId: string }
  /** Rename in place, in the row itself. */
  | { type: 'rename'; kind: 'session' | 'project'; id: string }
  /** Open the session and put the cursor in the tag box of its top line. */
  | { type: 'tag-session'; sessionId: string }
  | { type: 'archive'; kind: 'session' | 'project' | 'group'; id: string }
  /** Pin to (or unpin from) the top of the sidebar. */
  | { type: 'pin'; kind: 'session' | 'project' | 'group' | 'review'; id: string; pinned: boolean }
  /** Dismiss a request the user was asked to review, or restore a dismissed one (review-requests/store.ts). */
  | { type: 'dismiss-review'; key: string; dismissed: boolean }
  /** Open a review request: the session reviewing it when it has one, else its own page. */
  | { type: 'open-review'; key: string; sessionId?: string }
  /** Open an address in the browser (a request on its host). */
  | { type: 'open-link'; url: string }
  /** Mark a review request read, or unread again. */
  | { type: 'mark-review-read'; key: string; read: boolean }
  | { type: 'mark-ticket-read'; key: string; read: boolean }
  | { type: 'dismiss-ticket'; key: string; dismissed: boolean }
  | { type: 'open-ticket'; key: string }
  | { type: 'delete-session'; sessionId: string }
  | { type: 'mark-unread'; sessionId: string; unread: boolean }
  /** Show a folder in Finder (or copy its path where there is no Finder). */
  | { type: 'reveal'; path: string }
  /** `key`: who to tell it was copied (the button that opened the menu shows a tick). */
  | { type: 'copy'; text: string; what: string; key?: string }
  | { type: 'rename-folder'; groupId: string }
  | { type: 'delete-folder'; groupId: string }
  /** Open the item in a tab of its own, leaving the tab in front as it is. */
  | { type: 'open-new-tab'; item: OpenItem }
  | { type: 'move-session'; sessionId: string; groupId: string | null }
  | { type: 'stop-session'; sessionId: string }
  | { type: 'move-to-project'; sessionId: string; projectId: string }
  | { type: 'stop-folder'; groupId: string }
  /** A Sessions-list group, with its sessions, into a project (shared/project-groups.ts). */
  | { type: 'move-group-to-project'; groupId: string; projectId: string }
  /** A workstream's page (shared/workstreams.ts). */
  | { type: 'open-workstream'; workstreamId: string }
  /** Rename in place, in the workstream's row. */
  | { type: 'rename-workstream'; workstreamId: string }
  /** Stop every session the workstream points at. */
  | { type: 'stop-workstream'; workstreamId: string }
  /** Remove the grouping only: its sessions stay where they are. */
  | { type: 'delete-workstream'; workstreamId: string; /** Its sessions too, for good (asks first). */ withSessions?: boolean }
  /** Mark a workstream's work finished, or not finished after all. */
  | { type: 'set-workstream-status'; workstreamId: string; status: 'active' | 'complete' }
  /** Archive a workstream (out of the sidebar, still searchable) or bring it back. Its sessions are not touched. */
  | { type: 'archive-workstream'; workstreamId: string; archived: boolean; /** Its sessions too; on a restore, those archived with it. */ withSessions?: boolean }
  /** Tell a session's agent to run one of its ended commands again (the Commands pane). */
  | { type: 'retry-command'; sessionId: string; commandId: string }
  /** Stop one running command (the Commands pane). */
  | { type: 'stop-command'; sessionId: string; commandId: string }
  /** Put what a command printed (as the Commands pane shows it) on the clipboard. */
  | { type: 'copy-command-output'; sessionId: string; commandId: string }
  /** Open the folder a pane shows (a session's worktree, a project's folder) in an app, where it is. */
  | { type: 'open-folder'; scope: string; appId: string }
  /** A new session that carries on from a copy of this one's conversation (shared/fork.ts). */
  /** `turn`: the message that started the turn to fork from (TurnFork); absent, the end of the conversation. */
  | { type: 'fork-session'; sessionId: string; turn?: string }
  /** Take one session out of a workstream: only the reference goes. */
  | { type: 'remove-from-workstream'; workstreamId: string; sessionId: string }
  /** Autopilot for the session's pull request: on or off, or Merge when green (docs/designs/pr-autopilot.md). */
  | { type: 'set-autopilot'; sessionId: string; on: boolean; merge?: boolean };

/**
 * The menu of a row in the Commands pane. Its first item is what can be done with the command as
 * it stands (Matt, 2026-11-18): Stop command while it runs (disabled, with the reason, where the
 * agent cannot stop it on its own), Retry command when it failed, Re-run command when it finished
 * or was stopped. Retry and Re-run are one action: the session's agent is told to run it again.
 * `line` is the command as it was run, when it has one (a helper agent has none): Copy command says
 * so rather than copy nothing. Its output is asked for when Copy command output is picked, so the
 * menu never carries it.
 */
export function commandMenu(sessionId: string, command: { id: string; status: string; noStop?: string }, line: string | null): MenuItem[] {
  const first: MenuItem =
    command.status === 'running'
      ? { id: 'stop-command', label: 'Stop command', ...(command.noStop ? { disabled: true, hint: command.noStop } : { action: { type: 'stop-command', sessionId, commandId: command.id } }) }
      : { id: 'retry-command', label: command.status === 'failed' ? 'Retry command' : 'Re-run command', action: { type: 'retry-command', sessionId, commandId: command.id } };
  return [
    first,
    { id: 'copy-command', label: 'Copy command', separatorBefore: true, ...(line ? { action: { type: 'copy', text: line, what: 'command' } } : { disabled: true, hint: 'It has no command line' }) },
    { id: 'copy-command-output', label: 'Copy command output', action: { type: 'copy-command-output', sessionId, commandId: command.id } },
  ];
}

/** Something in the sidebar that can be shown in a tab. */
export type OpenItem = { kind: 'session'; id: string } | { kind: 'project'; id: string } | { kind: 'group'; id: string } | { kind: 'tag'; id: string } | { kind: 'workstream'; id: string } | { kind: 'overview' };

export interface MenuItem {
  id: string;
  label: string;
  action?: MenuAction;
  disabled?: boolean;
  /** Why an item is disabled. */
  hint?: string;
  /** A small picture before the label (an app's own icon), as an image URL. */
  icon?: string;
  children?: MenuItem[];
  separatorBefore?: boolean;
  /** A tick: this choice is the current one. On a `toggle` row, the switch is on. */
  checked?: boolean;
  /** Drawn as a switch (on when `checked`). Flipping it leaves the menu open. */
  toggle?: boolean;
  /** A key that picks this item while its menu is open, shown on the right ("1"). */
  shortcut?: string;
  /** The current choice inside a submenu, shown muted before its arrow ("Medium"). */
  value?: string;
  /** A small label drawn above the item, starting a section ("Fast mode"). */
  heading?: string;
}

// ---- the items themselves: used by the menu and by the "+" buttons --------------------------

export const item = {
  /** PINNED's own way to start a session: it is pinned the moment it exists. */
  newPinnedSession: (): MenuItem => ({ id: 'new-pinned-session', label: 'New pinned session', action: { type: 'new-session', pinned: true } }),
  newSession: (scope: { projectId?: string; groupId?: string } = {}): MenuItem => ({
    id: 'new-session',
    label: scope.groupId ? 'New session in this group' : scope.projectId ? 'New session here' : 'New session',
    action: { type: 'new-session', ...scope },
  }),
  /** In the Sessions list, or in a project's own list when `projectId` is given. */
  newFolder: (projectId?: string): MenuItem => ({ id: 'new-folder', label: 'New group', action: { type: 'new-folder', ...(projectId ? { projectId } : {}) } }),
  addProject: (): MenuItem => ({ id: 'add-project', label: 'Create project…', action: { type: 'add-project' } }),
  /** First on every sidebar item: a plain click replaces the tab in front, this does not. */
  openNewTab: (open: OpenItem): MenuItem => ({ id: 'open-new-tab', label: 'Open in new tab', action: { type: 'open-new-tab', item: open } }),
};

/**
 * The copy menu under a finished turn: the agent's response as it wrote it (markdown) or with the
 * formatting removed (text). `key` names the button it was opened from.
 */
export function copyResponseMenu(response: { markdown: string; text: string }, key: string): MenuItem[] {
  return [
    { id: 'copy-text', label: 'Copy text', action: { type: 'copy', text: response.text, what: 'text', key } },
    { id: 'copy-markdown', label: 'Copy markdown', action: { type: 'copy', text: response.markdown, what: 'markdown', key } },
  ];
}

/** Pin or Unpin, after Open in new tab; none when the caller did not say whether it is pinned. */
const pinItem = (kind: 'session' | 'project' | 'group' | 'review', id: string, pinned: boolean | undefined): MenuItem[] =>
  pinned === undefined ? [] : [{ id: 'pin', label: pinned ? 'Unpin' : 'Pin', action: { type: 'pin', kind, id, pinned: !pinned } }];

export type MenuTarget =
  | { kind: 'empty' }
  /** The PINNED heading. */
  | { kind: 'pinned' }
  | { kind: 'overview' }
  | {
      kind: 'project';
      projectId: string;
      /** Its name, which the menu's items say ("New session in Wren"). */
      name: string;
      sessionCount: number;
      /** Its default folder on disk; absent when it has none. */
      path?: string;
      /** A session in it is working. */
      running?: boolean;
      pinned?: boolean;
      /** False where nothing can show a folder (the browser build): only Copy path is offered. */
      canReveal?: boolean;
      /** Opened from the project's own page (its header …): "Open project page" would go nowhere. */
      onPage?: boolean;
      /** The apps that can open its folder; no Open in items without them. */
      openIn?: OpenInApps;
    }
  | {
      kind: 'folder';
      groupId: string;
      /** Its name, which the menu's items say ("New session in Launch"). */
      name: string;
      sessionCount: number;
      /** Something in it is running. */
      running?: boolean;
      pinned?: boolean;
      /** Opened from the group's own page. */
      onPage?: boolean;
      /** The project it belongs to; absent or null for a group in the Sessions list. */
      projectId?: string | null;
      /** Projects a Sessions-list group can be moved into; absent for a project's group, which stays. */
      projects?: readonly { id: string; name: string }[];
    }
  | { kind: 'tag'; tag: string }
  /**
   * A request the user was asked to review: its row in CODE REVIEWS, under PINNED, or on the Code
   * reviews page. `unread`: whether it is new; absent when that is not known. `dismissed`: it is
   * one the user dismissed. `url` and `service`: where it is on its host. `sessionId`: the session
   * reviewing it, when it has one.
   */
  | { kind: 'review'; key: string; pinned: boolean; unread?: boolean; dismissed?: boolean; url?: string; service?: string; sessionId?: string }
  /** A ticket's row, in the sidebar or on the Tickets page. `unread` is left out where it has no read state (a closed ticket); `canDismiss` false for one that is closed. */
  | { kind: 'ticket'; key: string; unread?: boolean; dismissed?: boolean; canDismiss?: boolean; url?: string; tracker?: string; details?: boolean }
  | {
      kind: 'workstream';
      workstreamId: string;
      name: string;
      /** A session it points at is working. */
      running?: boolean;
      /** Opened from the workstream's own page: "Open workstream page" would go nowhere. */
      onPage?: boolean;
      /** Its sessions in sight: archiving waits until none is still at work (`archiveRefusal`). */
      members?: readonly Pick<Session, 'id' | 'title' | 'state'>[];
      /** Its work is marked finished. */
      complete?: boolean;
      /** It is archived: the menu offers Restore. */
      archived?: boolean;
    }
  | {
      kind: 'session';
      sessionId: string;
      running: boolean;
      groupId: string | null;
      groups: readonly { id: string; name: string }[];
      /** Projects it could move to. */
      projects?: readonly { id: string; name: string }[];
      branch?: string | null;
      /** Its working folder on disk. */
      path?: string | null;
      /** It has output the user has not looked at. */
      unread?: boolean;
      pinned?: boolean;
      /** False where nothing can show a folder (the browser build): only Copy path is offered. */
      canReveal?: boolean;
      /** The workstream it is in, which it can be taken out of. */
      workstream?: { id: string; name: string; /** Why it cannot be taken out (`removeRefusal`): it is the lead. */ refusal?: string | null };
      /** Its agent, which decides whether it can be forked. No Fork item without it. */
      agent?: Agent;
      /** The apps that can open its folder; no Open in items without them. */
      openIn?: OpenInApps;
    };

/** The apps that can open a folder on this Mac, and the one "Open in" uses by default (Settings → Workflow). */
export interface OpenInApps {
  apps: readonly FolderApp[];
  defaultId: string | null;
}

/**
 * "Open in VS Code" (the default app, one click) and "Open in…" (every app), for the folder behind
 * a session or a project in the sidebar: the same apps and the same action as the panes' Open in
 * button (`openInMenu`). None when no app can open a folder or the apps are not known.
 */
function openInItems(scope: Scope, openIn: OpenInApps | undefined): MenuItem[] {
  if (!openIn || openIn.apps.length === 0) return [];
  const key = scopeKey(scope);
  const app = openIn.apps.find((a) => a.id === openIn.defaultId);
  const byDefault: MenuItem[] = app ? [{ id: 'open-in-default', label: `Open in ${app.label}`, action: { type: 'open-folder', scope: key, appId: app.id } }] : [];
  const items: MenuItem[] = [...byDefault, { id: 'open-in', label: 'Open in…', children: openInMenu(openIn.apps, key, openIn.defaultId) }];
  // The folder's own group: set apart from what is above it (Rename, Move).
  return [{ ...items[0]!, separatorBefore: true }, ...items.slice(1)];
}

/**
 * For a folder on disk: Open in (when `scope` and the apps are given), Show in Finder (only where
 * something can show it) and Copy path; none without a folder.
 */
function pathItems(path: string | null | undefined, canReveal = true, scope?: Scope, openIn?: OpenInApps): MenuItem[] {
  if (!path) return [];
  const copy: MenuItem = { id: 'copy-path', label: 'Copy path', action: { type: 'copy', text: path, what: 'path' } };
  const open = scope ? openInItems(scope, openIn) : [];
  // Worded for a Mac here; the page words it for the computer it is on (ui ContextMenu, `REVEAL_ID`).
  return canReveal ? [...open, { id: REVEAL_ID, label: showInFileManager('mac'), action: { type: 'reveal', path } }, copy] : [...open, copy];
}

/**
 * Fork, or why not now (`forkRefusal`). The session menu forks from the end; a turn's foot passes
 * its turn, and forks from it unless it is the last turn (which is the end).
 */
export function forkItem(sessionId: string, agent: Agent, running: boolean, turn?: TurnFork): MenuItem {
  const refusal = forkRefusal({ agent, working: running, ...(turn ? { turn } : {}) });
  if (refusal) return { id: 'fork', label: 'Fork', disabled: true, hint: refusal };
  const from = turn && !turn.latest && turn.turn ? { turn: turn.turn } : {};
  return { id: 'fork', label: 'Fork', action: { type: 'fork-session', sessionId, ...from } };
}

export function sidebarMenu(target: MenuTarget): MenuItem[] {
  switch (target.kind) {
    case 'empty':
      return [item.newSession(), item.newFolder(), item.addProject()];
    case 'pinned':
      return [item.newPinnedSession()];
    case 'overview':
      return [item.openNewTab({ kind: 'overview' })];
    case 'project': {
      // Pin is on the hover card; folders and agent setup are under Settings.
      const p = target.projectId;
      const open: MenuItem[] = [
        ...(target.onPage ? [] : [{ id: 'open-project', label: 'Open project page', action: { type: 'open-project', projectId: p } } satisfies MenuItem]),
        item.openNewTab({ kind: 'project', id: p }),
      ];
      return [
        { ...item.newSession({ projectId: p }), label: `New session in ${target.name}` },
        { ...item.newFolder(p), label: `New group in ${target.name}` },
        { ...open[0]!, separatorBefore: true },
        ...open.slice(1),
        { id: 'rename', label: `Rename ${target.name}`, action: { type: 'rename', kind: 'project', id: p }, separatorBefore: true },
        ...pathItems(target.path, target.canReveal, { kind: 'project', id: p }, target.openIn),
        { id: 'project-settings', label: 'Settings…', action: { type: 'project-settings', projectId: p }, separatorBefore: true },
        { id: 'archive', label: 'Archive', action: { type: 'archive', kind: 'project', id: p }, disabled: target.running === true, separatorBefore: true },
        { id: 'remove-project', label: 'Remove', action: { type: 'remove-project', projectId: p }, disabled: target.sessionCount > 0 },
      ];
    }
    case 'folder': {
      // Like a project's: create · open · its name · stop · archive and delete. A group holds no
      // group, so New group is on the project or the Sessions list, not here.
      const g = target.groupId;
      const open: MenuItem[] = [
        ...(target.onPage ? [] : [{ id: 'open-group', label: 'Open group page', action: { type: 'open-group', groupId: g } } satisfies MenuItem]),
        item.openNewTab({ kind: 'group', id: g }),
        ...pinItem('group', g, target.pinned),
      ];
      return [
        { ...item.newSession({ groupId: g, ...(target.projectId ? { projectId: target.projectId } : {}) }), label: `New session in ${target.name}` },
        { ...open[0]!, separatorBefore: true },
        ...open.slice(1),
        { id: 'rename-folder', label: `Rename ${target.name}`, action: { type: 'rename-folder', groupId: g }, separatorBefore: true },
        ...(target.projects && !target.projectId
          ? [
              {
                id: 'move-group-project',
                label: 'Move to project',
                children: target.projects.map((p) => ({ id: `to-${p.id}`, label: p.name, action: { type: 'move-group-to-project', groupId: g, projectId: p.id } as MenuAction })),
                disabled: target.projects.length === 0,
                hint: target.projects.length === 0 ? 'No project yet' : undefined,
              } satisfies MenuItem,
            ]
          : []),
        ...(target.running ? [{ id: 'stop-folder', label: 'Stop all sessions', action: { type: 'stop-folder', groupId: g } as MenuAction, separatorBefore: true }] : []),
        { id: 'archive', label: 'Archive', action: { type: 'archive', kind: 'group', id: g }, disabled: target.running === true, separatorBefore: true },
        { id: 'delete-folder', label: 'Delete', action: { type: 'delete-folder', groupId: g } },
      ];
    }
    case 'review': {
      const k = target.key;
      const read: MenuItem[] = target.unread !== undefined && !target.dismissed ? [{ id: 'mark-review-read', label: target.unread ? 'Mark as read' : 'Mark as unread', action: { type: 'mark-review-read', key: k, read: target.unread } }] : [];
      const host: MenuItem[] = target.url
        ? [
            { id: 'open-link', label: `Open on ${target.service ?? 'its host'}`, action: { type: 'open-link', url: target.url } },
            { id: 'copy-link', label: 'Copy link', action: { type: 'copy', text: target.url, what: 'Link' } },
          ]
        : [];
      return [
        { id: 'open-review', label: target.sessionId ? 'Open review' : 'Open', action: { type: 'open-review', key: k, ...(target.sessionId ? { sessionId: target.sessionId } : {}) } },
        ...host,
        ...read.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item)),
        // A dismissed request is not drawn under PINNED, so it has no Pin.
        ...(target.dismissed ? [] : pinItem('review', k, target.pinned)),
        { id: 'dismiss-review', label: target.dismissed ? 'Restore' : 'Dismiss', action: { type: 'dismiss-review', key: k, dismissed: !target.dismissed }, separatorBefore: true },
      ];
    }
    case 'ticket': {
      const k = target.key;
      const read: MenuItem[] = target.unread !== undefined && !target.dismissed ? [{ id: 'mark-ticket-read', label: target.unread ? 'Mark as read' : 'Mark as unread', action: { type: 'mark-ticket-read', key: k, read: target.unread } }] : [];
      const tracker: MenuItem[] = target.url
        ? [
            { id: 'open-link', label: `Open in ${target.tracker ?? 'its tracker'}`, action: { type: 'open-link', url: target.url } },
            { id: 'copy-link', label: 'Copy link', action: { type: 'copy', text: target.url, what: 'Link' } },
          ]
        : [];
      const dismiss: MenuItem[] = target.canDismiss === false ? [] : [{ id: 'dismiss-ticket', label: target.dismissed ? 'Restore' : 'Dismiss', action: { type: 'dismiss-ticket', key: k, dismissed: !target.dismissed }, separatorBefore: true }];
      return [
        ...(target.details === false ? [] : [{ id: 'open-ticket', label: 'View ticket details', action: { type: 'open-ticket', key: k } as MenuAction }]),
        ...tracker,
        ...read.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item)),
        ...dismiss,
      ];
    }
    case 'tag':
      return [{ id: 'open-tag', label: 'Open tag page', action: { type: 'open-tag', tag: target.tag } }, item.openNewTab({ kind: 'tag', id: target.tag })];
    case 'workstream': {
      const w = target.workstreamId;
      // Like a group's: open · rename · stop · delete. No "New session": a session joins by being delegated to.
      return [
        ...(target.onPage ? [] : [{ id: 'open-workstream', label: 'Open workstream page', action: { type: 'open-workstream', workstreamId: w } as MenuAction }]),
        item.openNewTab({ kind: 'workstream', id: w }),
        { id: 'rename-workstream', label: `Rename ${target.name}`, action: { type: 'rename-workstream', workstreamId: w }, separatorBefore: true },
        ...(target.running ? [{ id: 'stop-workstream', label: 'Stop all sessions', action: { type: 'stop-workstream', workstreamId: w } as MenuAction, separatorBefore: true }] : []),
        // Complete records the outcome; archiving controls whether it is still in the sidebar.
        target.complete
          ? { id: 'reopen-workstream', label: 'Mark as not complete', action: { type: 'set-workstream-status', workstreamId: w, status: 'active' }, separatorBefore: true }
          : { id: 'complete-workstream', label: 'Mark complete', action: { type: 'set-workstream-status', workstreamId: w, status: 'complete' }, separatorBefore: true },
        ...(target.archived
          ? [
              { id: 'restore-workstream', label: 'Restore workstream', action: { type: 'archive-workstream', workstreamId: w, archived: false } as MenuAction },
              { id: 'delete-workstream', label: 'Delete workstream', action: { type: 'delete-workstream', workstreamId: w } as MenuAction, separatorBefore: true },
            ]
          : cleanUpItems(target.name, w, target.members ?? [])),
      ];
    }
    case 'session': {
      const destinations: MenuItem[] = [
        ...(target.groupId !== null ? [{ id: 'move-none', label: 'No group', action: { type: 'move-session', sessionId: target.sessionId, groupId: null } as MenuAction }] : []),
        ...target.groups.filter((g) => g.id !== target.groupId).map((g) => ({ id: `move-${g.id}`, label: g.name, action: { type: 'move-session', sessionId: target.sessionId, groupId: g.id } as MenuAction })),
      ];
      const onDisk: MenuItem[] = [
        ...pathItems(target.path, target.canReveal, { kind: 'session', id: target.sessionId }, target.openIn),
        ...(target.branch ? [{ id: 'copy-branch', label: 'Copy branch name', action: { type: 'copy', text: target.branch, what: 'branch name' } as MenuAction }] : []),
      ];
      if (onDisk[0]) onDisk[0] = { ...onDisk[0], separatorBefore: true };
      // Like a project's: open (and its read state) · rename, tag and moves · on disk · stop · archive and delete.
      return [
        item.openNewTab({ kind: 'session', id: target.sessionId }),
        // A workstream's row and tab stand for its lead, so they open this menu: its page is reached from here too (Matt, 2026-11-22).
        ...(target.workstream ? [{ id: 'open-workstream', label: 'Open workstream page', action: { type: 'open-workstream', workstreamId: target.workstream.id } as MenuAction }] : []),
        ...pinItem('session', target.sessionId, target.pinned),
        ...(target.unread !== undefined ? [{ id: 'mark-unread', label: target.unread ? 'Mark as read' : 'Mark as unread', action: { type: 'mark-unread', sessionId: target.sessionId, unread: !target.unread } as MenuAction }] : []),
        { id: 'rename', label: 'Rename', action: { type: 'rename', kind: 'session', id: target.sessionId }, separatorBefore: true },
        { id: 'tag', label: 'Tag…', action: { type: 'tag-session', sessionId: target.sessionId } },
        // Nowhere to go: the item is dimmed, with no submenu and no reason line (Matt, 2026-11-22).
        destinations.length === 0 ? { id: 'move', label: 'Move to group', disabled: true } : { id: 'move', label: 'Move to group', children: destinations },
        ...(target.projects
          ? [{ id: 'move-project', label: 'Move to project…', ...(target.projects.length === 0 ? { disabled: true } : { children: target.projects.map((p) => ({ id: `to-${p.id}`, label: p.name, action: { type: 'move-to-project', sessionId: target.sessionId, projectId: p.id } as MenuAction })) }) }]
          : []),
        ...(target.agent ? [forkItem(target.sessionId, target.agent, target.running)] : []),
        ...(target.workstream
          ? [
              target.workstream.refusal
                ? { id: 'leave-workstream', label: `Remove from ${target.workstream.name}`, disabled: true, hint: target.workstream.refusal }
                : { id: 'leave-workstream', label: `Remove from ${target.workstream.name}`, action: { type: 'remove-from-workstream', workstreamId: target.workstream.id, sessionId: target.sessionId } as MenuAction },
            ]
          : []),
        ...onDisk,
        ...(target.running ? [{ id: 'stop', label: 'Stop', action: { type: 'stop-session', sessionId: target.sessionId } as MenuAction, separatorBefore: true }] : []),
        { id: 'archive', label: 'Archive', action: { type: 'archive', kind: 'session', id: target.sessionId }, disabled: target.running, separatorBefore: true },
        { id: 'delete', label: 'Delete…', action: { type: 'delete-session', sessionId: target.sessionId }, disabled: target.running },
      ];
    }
  }
}
