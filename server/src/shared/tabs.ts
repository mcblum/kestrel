// Tab state for the main area. Pure and immutable: every function returns a new state.
// Tabs work like a browser's: a click (New session included) shows something in the tab in front;
// a new tab is only made when asked for (the tab-strip `+`, "Open in new tab", shift/Cmd/middle click).
import type { Agent } from '../model.ts';
import type { PermissionLevel } from './permissions.ts';

/** What the composer controls hold. Pre-filled from the last session's choices. */
export interface Controls {
  agent: Agent;
  model: string;
  /** Reasoning effort; empty or absent means the model's default (shared/model-choice.ts). */
  effort?: string;
  /** Fast mode; absent means off. */
  fast?: boolean;
  permission: PermissionLevel;
  /** A registered project, or null for "No project (read only)". */
  projectId: string | null;
  /** Folder to file the new session in, when opened from a folder's menu. */
  groupId: string | null;
  /** The project directory to start in, when the project has several; unset means the last one used. */
  folderId?: string | null;
  /** Pin the session as soon as it exists (a draft opened from PINNED's "New pinned session"). Never remembered. */
  pinned?: boolean;
  /** The user picked the model, effort or fast mode for this draft themselves: the session keeps it when it leads (shared/who-does-what.ts). Never remembered. */
  modelChosen?: boolean;
}

export type Tab =
  /** A list page: Overview, a project, a group, Settings. `path` is its route, e.g. `#/project/x`. */
  | { id: string; kind: 'page'; path: string }
  | { id: string; kind: 'session'; sessionId: string }
  /** Nothing exists on the server for this tab until its first message is sent. */
  | { id: string; kind: 'new'; controls: Controls };

export interface TabsState {
  tabs: Tab[];
  activeId: string;
}

export const OVERVIEW_ID = 'overview';
export const OVERVIEW_PATH = '#/';
export const MAX_TABS = 30;

const overviewTab = (): Tab => ({ id: OVERVIEW_ID, kind: 'page', path: OVERVIEW_PATH });
export const initialTabs = (): TabsState => ({ tabs: [overviewTab()], activeId: OVERVIEW_ID });

export const DEFAULT_CONTROLS: Controls = { agent: 'claude', model: '', permission: 'ask', projectId: null, groupId: null };

const has = (s: TabsState, id: string) => s.tabs.some((t) => t.id === id);

export function activate(s: TabsState, id: string): TabsState {
  return has(s, id) && s.activeId !== id ? { ...s, activeId: id } : s;
}

/** Cmd-1..9: the nth tab, 1-based. Out of range changes nothing. */
export function activateNth(s: TabsState, n: number): TabsState {
  const tab = s.tabs[n - 1];
  return tab ? activate(s, tab.id) : s;
}

// ---- opening something: like a browser ------------------------------------------------------

/** The project or folder an entry point named ("New session here"), applied to the screen it opens. */
export type Preselect = Partial<Pick<Controls, 'projectId' | 'groupId'>>;

/** What a click opens: a session, a list page by its route, or the New session screen. */
export type OpenTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'page'; path: string }
  /** `controls` fill a screen made for it; `preselect` is also applied to an unsent screen that is focused instead. */
  | { kind: 'new'; controls: Controls; preselect?: Preselect };

export interface OpenOptions {
  /** The tab-strip `+`, shift-click, Cmd-click, middle click or "Open in new tab". */
  newTab: boolean;
}

/**
 * Where a target opens. A plain click shows it in the tab in front, replacing what was there,
 * unless it is already open in a tab (that tab is focused). Any unsent New session screen counts
 * as showing New session, so there is never a second one unless a new tab is asked for. Asking
 * for a new tab always gets one.
 */
export type Placement = { how: 'focus'; tabId: string } | { how: 'replace' } | { how: 'new' };

function shows(tab: Tab, target: OpenTarget): boolean {
  if (target.kind === 'session') return tab.kind === 'session' && tab.sessionId === target.sessionId;
  if (target.kind === 'page') return tab.kind === 'page' && tab.path === target.path;
  return tab.kind === 'new';
}

export function placement(s: TabsState, target: OpenTarget, options: OpenOptions): Placement {
  if (options.newTab) return { how: 'new' };
  const active = s.tabs.find((t) => t.id === s.activeId);
  if (active && shows(active, target)) return { how: 'focus', tabId: active.id };
  const existing = s.tabs.find((t) => shows(t, target));
  if (existing) return { how: 'focus', tabId: existing.id };
  return active ? { how: 'replace' } : { how: 'new' };
}

/**
 * Controls with a project or group chosen. A directory belongs to one project: when the project
 * changes, the directory chosen for the old one is dropped, so the new one starts on its own.
 */
export function withScope(controls: Controls, choice: Partial<Controls>): Controls {
  const next = { ...controls, ...choice };
  if (choice.projectId === undefined || choice.projectId === controls.projectId || 'folderId' in choice) return next;
  const { folderId: _dropped, ...rest } = next;
  return rest;
}

function tabFor(id: string, target: OpenTarget): Tab {
  if (target.kind === 'session') return { id, kind: 'session', sessionId: target.sessionId };
  if (target.kind === 'page') return { id, kind: 'page', path: target.path };
  return { id, kind: 'new', controls: withScope(target.controls, target.preselect ?? {}) };
}

/** Apply a preselection to an unsent tab; unchanged state when it changes nothing. */
function preselect(s: TabsState, id: string, choice: Preselect | undefined): TabsState {
  const tab = s.tabs.find((t) => t.id === id);
  if (!choice || tab?.kind !== 'new') return s;
  const controls = withScope(tab.controls, choice);
  return controls.projectId === tab.controls.projectId && controls.groupId === tab.controls.groupId ? s : setControls(s, id, controls);
}

/**
 * Open a target where `placement` says. A replaced tab keeps its place in the strip but takes
 * `newId`, so nothing keyed by the old tab (its view, its draft) carries over to what replaced it.
 */
export function openTarget(s: TabsState, target: OpenTarget, newId: string, options: OpenOptions): TabsState {
  const where = placement(s, target, options);
  if (where.how === 'focus') return preselect(activate(s, where.tabId), where.tabId, target.kind === 'new' ? target.preselect : undefined);
  if (where.how === 'replace') return { tabs: s.tabs.map((t) => (t.id === s.activeId ? tabFor(newId, target) : t)), activeId: newId };
  if (s.tabs.length >= MAX_TABS) return s;
  return { tabs: [...s.tabs, tabFor(newId, target)], activeId: newId };
}

export function setControls(s: TabsState, id: string, controls: Controls): TabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id && t.kind === 'new' ? { ...t, controls } : t)) };
}

/** The new tab becomes the session in place: same tab, same position. */
export function becomeSession(s: TabsState, id: string, sessionId: string): TabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id && t.kind === 'new' ? { id, kind: 'session', sessionId } : t)) };
}

/**
 * The page tab in front shows another path, keeping its id and place: a local tab inside the page
 * (a project's Sessions or Settings) changes, the workspace tab does not. Unchanged for a session tab.
 */
export function retargetActive(s: TabsState, path: string): TabsState {
  const active = s.tabs.find((t) => t.id === s.activeId);
  if (active?.kind !== 'page' || active.path === path) return s;
  return { ...s, tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, path } : t)) };
}

/** True when only one tab is open: it shows no close button. */
export const isOnlyTab = (s: TabsState) => s.tabs.length === 1;

/** True for the one tab that cannot close at all: Overview when nothing else is open. */
export const isLastOverview = (s: TabsState) => s.tabs.length === 1 && s.tabs[0]!.kind === 'page' && s.tabs[0]!.path === OVERVIEW_PATH;

/** Close a tab. The active tab moves to its left neighbour; closing the last tab leaves Overview. */
export function closeTab(s: TabsState, id: string): TabsState {
  const index = s.tabs.findIndex((t) => t.id === id);
  if (index < 0 || isLastOverview(s)) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return initialTabs();
  const activeId = s.activeId === id ? tabs[Math.max(0, index - 1)]!.id : s.activeId;
  return { tabs, activeId };
}

/** Move a tab to a position. */
export function moveTab(s: TabsState, id: string, toIndex: number): TabsState {
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from < 0) return s;
  const to = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
  if (to === from) return s;
  const tabs = [...s.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab!);
  return { ...s, tabs };
}

const NONE_AWAITED: ReadonlySet<string> = new Set();

/** Drop tabs for sessions that no longer exist; keep the active tab valid and at least Overview open. *
 * `awaited` are sessions this client has just created and the workspace has not listed yet: the
 * create request can come back before the pushed list that includes the new session, and without
 * this its tab was dropped and the user was left on the first tab (the Overview).
 */
export function prune(s: TabsState, sessionIds: ReadonlySet<string>, awaited: ReadonlySet<string> = NONE_AWAITED): TabsState {
  const tabs = s.tabs.filter((t) => t.kind !== 'session' || sessionIds.has(t.sessionId) || awaited.has(t.sessionId));
  if (tabs.length === s.tabs.length) return s;
  if (tabs.length === 0) return initialTabs();
  return { tabs, activeId: tabs.some((t) => t.id === s.activeId) ? s.activeId : tabs[0]!.id };
}

/**
 * A session gave way to another (a first-message review request made into a review session):
 * every tab showing the old one shows the new one, in the same place. When the new one is already
 * open in a tab of its own, the old one's tab is closed and that one comes to the front in its
 * stead. Unchanged when no tab shows the old session.
 */
export function replaceSession(s: TabsState, oldId: string, newId: string): TabsState {
  const showsOld = (t: Tab) => t.kind === 'session' && t.sessionId === oldId;
  if (!s.tabs.some(showsOld)) return s;
  const already = s.tabs.find((t) => t.kind === 'session' && t.sessionId === newId);
  const wasInFront = s.tabs.some((t) => showsOld(t) && t.id === s.activeId);
  if (already) {
    const tabs = s.tabs.filter((t) => !showsOld(t));
    return { tabs, activeId: wasInFront ? already.id : s.activeId };
  }
  return { ...s, tabs: s.tabs.map((t) => (showsOld(t) ? { ...t, kind: 'session' as const, sessionId: newId } : t)) };
}

/**
 * Accept stored state only if it is well-formed; otherwise start over. State saved before tabs
 * could hold any page had a pinned `overview` tab: it comes back as an Overview page.
 */
export function sanitize(raw: unknown): TabsState {
  const value = raw as Partial<TabsState> | null;
  if (!value || !Array.isArray(value.tabs)) return initialTabs();
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of value.tabs as (Tab | { id: string; kind: 'overview' })[]) {
    if (!t || typeof t.id !== 'string' || seen.has(t.id) || tabs.length >= MAX_TABS) continue;
    if (t.kind === 'session' && typeof t.sessionId === 'string') tabs.push({ id: t.id, kind: 'session', sessionId: t.sessionId });
    else if (t.kind === 'new' && t.controls && typeof t.controls === 'object') tabs.push({ id: t.id, kind: 'new', controls: { ...DEFAULT_CONTROLS, ...t.controls } });
    else if (t.kind === 'page' && typeof t.path === 'string' && t.path.startsWith('#/')) tabs.push({ id: t.id, kind: 'page', path: t.path });
    else if (t.kind === 'overview') tabs.push({ id: t.id, kind: 'page', path: OVERVIEW_PATH });
    else continue;
    seen.add(t.id);
  }
  if (tabs.length === 0) return initialTabs();
  return { tabs, activeId: typeof value.activeId === 'string' && seen.has(value.activeId) ? value.activeId : tabs[0]!.id };
}

/** Where the user is looking: a project, a folder, or neither. */
export interface Scope {
  projectId?: string;
  groupId?: string;
}

/**
 * The scope a plain "New session" inherits. On a page tab it is the page shown (a project
 * or folder page); on a session tab it is that session's project and folder; on an unsent tab it
 * is that tab's own choices. Empty when none of those names a project or folder.
 */
export function scopeOfActive(s: TabsState, page: Scope, sessions: readonly { id: string; startedIn: string | null; landedIn: string | null; groupId: string | null }[]): Scope {
  const tab = s.tabs.find((t) => t.id === s.activeId);
  if (!tab || tab.kind === 'page') return page;
  const from = (projectId: string | null, groupId: string | null): Scope => ({ ...(projectId ? { projectId } : {}), ...(groupId ? { groupId } : {}) });
  if (tab.kind === 'new') return from(tab.controls.projectId, tab.controls.groupId);
  const session = sessions.find((x) => x.id === tab.sessionId);
  return session ? from(session.landedIn ?? session.startedIn, session.groupId) : {};
}
