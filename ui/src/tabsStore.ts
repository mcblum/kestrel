// Open tabs and the composer's last choices. The server keeps them (not localStorage), so the
// Electron window and a browser tab agree. Everything pure lives in @kestrel/server/tabs.
import { guardLeave } from './unsaved.ts';
import { DEFAULT_CONTROLS, withScope, activate, openBeside, placement, activateNth, becomeSession, closeTab, isLastOverview, moveTab, openTarget, prune, replaceSession, retargetActive, sanitize, setControls, type Controls, type OpenTarget, type Preselect, type Tab, type TabsState } from '@kestrel/server/tabs';
import { rememberPick, rememberPreset, rememberSent, startControls, startFromOf, storedRemembered, withFixed, withStartFrom, type Remembered, type StartFrom, type StickyPick } from '@kestrel/server/sticky-controls';
import { clampChangesListHeight } from '@kestrel/server/changes-split';
import { clampContextWidth, clampPaneWidth, clampSimWidth, clampWidth, place, placeMenuItem, placeProject, placeTag, placeWorkstream, sanitizeSidebar, toggleCollapsed, toggleHidden, type SidebarPrefs } from '@kestrel/server/sidebar';
import { activityAt, parseSessionOrder, type SessionOrder } from '@kestrel/server/session-order';
import type { StackWeights } from '@kestrel/server/pane-layout';
import type { ScopeKind } from '@kestrel/server/scope';
import { markSeen } from '@kestrel/server/unread';
import { appStore, call, drafts, setApp, useApp } from './store.ts';

export interface TabsView {
  /** False until the saved tabs have been read from the server. */
  loaded: boolean;
  state: TabsState;
  /** What new sessions start with: the agent last used, and each agent's last picks (sticky-controls.ts). */
  remembered: Remembered;
  /** The sidebar's order and what is collapsed. */
  sidebar: SidebarPrefs;
}

/** The tabs as they are now, for code outside React. They live in the app store's `tabs` slice. */
export const tabsView = (): TabsView => appStore.get().tabs;
const setView = (next: TabsView) => setApp({ tabs: next });

export function useTabs<T>(select: (v: TabsView) => T): T {
  return useApp((s) => select(s.tabs));
}

// ---- persistence ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (!tabsView().loaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void call('/api/ui-state', { method: 'PUT', body: JSON.stringify({ tabs: tabsView().state, remembered: tabsView().remembered, sidebar: tabsView().sidebar }) }).catch(() => undefined);
  }, 300);
}

function update(patch: Partial<TabsView>) {
  setView({ ...tabsView(), ...patch });
  save();
}

let loading = false;
async function load() {
  if (loading || tabsView().loaded) return;
  loading = true;
  try {
    const stored = await call<{ tabs?: unknown; remembered?: unknown; lastControls?: unknown; sidebar?: unknown }>('/api/ui-state');
    // A store from before 0.0.17 holds one `lastControls`; it is read once into `remembered`.
    setView({ loaded: true, state: sanitize(stored.tabs), remembered: storedRemembered(stored), sidebar: sanitizeSidebar(stored.sidebar) });
    pruneMissing();
  } catch {
    loading = false;
  }
}

/**
 * Sessions this page has just created (a draft's first message), until the workspace's pushed list
 * includes them. Their tabs are not "for a session that no longer exists" in that moment.
 */
const awaited = new Set<string>();

/** Tabs for sessions that no longer exist are dropped once the workspace is known. */
function pruneMissing() {
  const ws = appStore.get().workspace;
  if (!tabsView().loaded || !ws) return;
  const listed = new Set(ws.sessions.map((s) => s.id));
  // Once the workspace lists a session we created, it is an ordinary session again.
  for (const id of awaited) if (listed.has(id)) awaited.delete(id);
  const next = prune(tabsView().state, listed, awaited);
  if (next !== tabsView().state) setView({ ...tabsView(), state: next });
}

/**
 * A session that gave way to another (a first-message review request made into a review session,
 * server: review-requests/convert.ts): its tab shows the one that replaced it, before the old one
 * is pruned as deleted. The new one may not be in the pushed workspace yet, so it is awaited.
 */
function followReplaced() {
  const live = appStore.get().live;
  let state = tabsView().state;
  for (const tab of state.tabs) {
    const to = tab.kind === 'session' ? live.get(tab.sessionId)?.replacedBy : undefined;
    if (!to || tab.kind !== 'session') continue;
    awaited.add(to);
    state = replaceSession(state, tab.sessionId, to);
  }
  if (state !== tabsView().state) setView({ ...tabsView(), state });
}

function sync() {
  const s = appStore.get();
  if (s.connection === 'live' && !tabsView().loaded) void load();
  if (tabsView().loaded) {
    const before = tabsView().state;
    followReplaced();
    pruneMissing();
    if (tabsView().state !== before) save();
    trackSeen();
  }
}

/**
 * The session in the tab in front is looked at whenever it changes, as long as the window has focus.
 * The record is the server's (server/src/seen.ts), so this asks it to mark the session, and every
 * window, and a paired phone, hears the new record. Asked once per session and activity.
 */
let asked = '';
/** A session marked unread by hand while it is the tab in front: it stays unread until another tab is in front. */
let heldUnread: string | null = null;
function trackSeen() {
  const { workspace: ws, seen } = appStore.get();
  if (!tabsView().loaded || !ws || !seen) return;
  const tab = tabsView().state.tabs.find((t) => t.id === tabsView().state.activeId);
  const front = tab?.kind === 'session' ? tab.sessionId : null;
  if (heldUnread !== null && front !== heldUnread) heldUnread = null;
  const open = front !== null && front !== heldUnread && document.hasFocus() ? ws.sessions.find((s) => s.id === front) : undefined;
  if (!open || markSeen(seen, open) === seen) return;
  const key = `${open.id}:${activityAt(open)}`;
  if (key === asked) return;
  asked = key;
  void postSeen({ sessionIds: [open.id] });
}
const postSeen = (body: { sessionIds: string[]; unread?: true }) => call('/api/seen', { method: 'POST', body: JSON.stringify(body) }).catch(() => { asked = ''; });
if (typeof window !== 'undefined') window.addEventListener('focus', trackSeen);
appStore.subscribe(sync);
// The app may already be connected when this module starts (a hot reload in development):
// waiting for the next store change would leave the page on "Connecting…".
sync();

// ---- actions ------------------------------------------------------------------------------

const newId = () => crypto.randomUUID();
/** What the next new session starts with: no folder, and the model, effort, fast mode and mode the user last chose by hand on its agent. */
// The directory is not remembered: a new session starts on its project's last-used directory, read from the sessions (lastUsedFolder).
// Those four are set only by `chooseControls`, so a draft sent with older choices does not undo a later pick.
const remembered = (controls: Controls): Remembered => rememberSent(controls, tabsView().remembered);
/** The controls a new session starts with now. */
export const startingControls = (v: TabsView): Controls => startControls(v.remembered);
export const startingFrom = (v: TabsView): StartFrom => startFromOf(v.remembered);
/** The preset last picked by hand (its id): which of two otherwise identical presets shows as chosen. */
export const pickedPreset = (v: TabsView): string | undefined => v.remembered.preset;
const apply = (next: TabsState) => {
  if (next === tabsView().state) return;
  update({ state: next });
  trackSeen(); // the tab now in front has been looked at
};

// ---- the parked draft: one remembered unsent message --------------------------------------
// A plain navigation may replace an unsent New session screen. Its text and choices are parked
// here (on this machine, like every draft) and come back the next time New session is shown in
// place. Tabs opened with the tab-strip `+` keep their own drafts, keyed by tab.

const PARKED_TEXT = 'new-session';
const PARKED_CONTROLS = 'new-session:controls';

function parked(): { text: string; controls: Controls } | null {
  const text = drafts.get(PARKED_TEXT);
  if (!text.trim()) return null;
  try {
    return { text, controls: { ...DEFAULT_CONTROLS, ...(JSON.parse(drafts.get(PARKED_CONTROLS) || '{}') as Partial<Controls>) } };
  } catch {
    return { text, controls: startingControls(tabsView()) };
  }
}

function setParked(text: string, controls: Controls | null): void {
  drafts.set(PARKED_TEXT, text);
  drafts.set(PARKED_CONTROLS, controls ? JSON.stringify(controls) : '');
}

/** An unsent tab that is no longer in the strip: park its text if it had any, then forget it. */
function parkIfReplaced(before: Tab | undefined, next: TabsState): void {
  if (before?.kind !== 'new' || next.tabs.some((t) => t.id === before.id)) return;
  const text = drafts.get(`tab:${before.id}`);
  if (text.trim()) setParked(text, before.controls);
  drafts.set(`tab:${before.id}`, '');
}

/** Open a target where `placement` says; the one path by which anything is shown or a tab is added. */
function show(target: OpenTarget, newTab: boolean, id = newId()): void {
  const before = tabsView().state.tabs.find((t) => t.id === tabsView().state.activeId);
  const next = openTarget(tabsView().state, target, id, { newTab });
  parkIfReplaced(before, next);
  apply(next);
}

function openNewNow(prefill: Partial<Controls>, choice: Preselect, newTab: boolean): void {
  const restore = newTab ? null : parked();
  const scoped = restore?.controls ?? withScope(startingControls(tabsView()), prefill);
  // Whether it will be pinned is this request's, never a remembered or parked choice.
  const { pinned: _was, purpose: _purpose, ...plain } = scoped;
  const controls: Controls = prefill.pinned ? { ...plain, pinned: true } : plain;
  const id = newId();
  // The parked text moves to the screen made for it before it renders (it reads its draft once).
  // An unsent screen that is focused instead leaves the parked draft where it is.
  if (restore && placement(tabsView().state, { kind: 'new', controls }, { newTab }).how !== 'focus') {
    drafts.set(`tab:${id}`, restore.text);
    setParked('', null);
  }
  show({ kind: 'new', controls, preselect: choice }, newTab, id);
}

/** Ask the agent (onboarding.md 18.12): a New session screen of its own, with no project, its message filled in and not sent. */
function openSetupAskNow(text: string): void {
  const { pinned: _was, purpose: _purpose, ...plain } = withScope(startingControls(tabsView()), { projectId: null, groupId: null });
  const id = newId();
  // The screen reads its draft once, as it renders: the text is put there first.
  drafts.set(`tab:${id}`, text);
  show({ kind: 'new', controls: { ...plain, purpose: 'setup' }, preselect: { projectId: null } }, true, id);
}

export const tabActions = {
  /** Ask the agent about a Set up this computer step: nothing is sent until the person presses send. */
  openSetupAsk: (text: string): void => guardLeave(() => openSetupAskNow(text)),
  /** Show a session or page: in the tab in front, in the tab already showing it, or in a new tab. */
  open(target: Extract<OpenTarget, { kind: 'session' | 'page' }>, newTab = false): void {
    guardLeave(() => show(target, newTab));
  },
  /** A page in a new tab just after the one in front, which keeps its place; brought to the front only when `focus` (What's new after an update). */
  openBeside: (path: string, focus: boolean) => apply(openBeside(tabsView().state, path, newId(), { focus })),
  /** Another local tab of the page in front (a project's Sessions or Settings): same workspace tab. */
  showInPlace: (path: string) => guardLeave(() => apply(retargetActive(tabsView().state, path))),
  /**
   * Show the New session screen: in place of the tab in front, or the unsent screen already open
   * (with `preselect` applied), or (`newTab`) in a tab of its own. Shown in place, it brings back
   * the parked draft if there is one. Nothing is created on the server until the first message.
   */
  openNew: (prefill: Partial<Controls>, choice: Preselect, newTab: boolean): void => guardLeave(() => openNewNow(prefill, choice, newTab)),
  activate: (id: string) => (id === tabsView().state.activeId ? undefined : guardLeave(() => apply(activate(tabsView().state, id)))),
  activateNth: (n: number) => guardLeave(() => apply(activateNth(tabsView().state, n))),
  /** Step to the next or previous tab, wrapping. */
  step(delta: 1 | -1) {
    const { tabs, activeId } = tabsView().state;
    const i = tabs.findIndex((t) => t.id === activeId);
    guardLeave(() => apply(activate(tabsView().state, tabs[(i + delta + tabs.length) % tabs.length]!.id)));
  },
  close(id: string, confirmDiscard = true): void {
    const tab = tabsView().state.tabs.find((t) => t.id === id);
    if (!tab || isLastOverview(tabsView().state)) return;
    // An unsent tab is discarded silently unless it has text.
    if (tab.kind === 'new' && confirmDiscard && drafts.get(`tab:${id}`).trim() && !window.confirm('Discard the message you have not sent?')) return;
    const shut = () => {
      if (tab.kind === 'new') drafts.set(`tab:${id}`, '');
      apply(closeTab(tabsView().state, id));
    };
    // Only closing the tab in front takes the user off a screen with changes not saved.
    return id === tabsView().state.activeId ? guardLeave(shut) : shut();
  },
  closeActive: () => tabActions.close(tabsView().state.activeId),
  move: (id: string, toIndex: number) => apply(moveTab(tabsView().state, id, toIndex)),
  setControls: (id: string, controls: Controls) => apply(setControls(tabsView().state, id, controls)),
  /**
   * A session this page just made another way (a fork) is about to be opened: keep its tab until
   * the workspace's pushed list includes it, as for a draft's first message.
   */
  expect(sessionId: string) {
    awaited.add(sessionId);
  },
  /**
   * The first message was sent: this tab is now that session, in place. Remember the choices, unless they were
   * another computer's (`controls` null: a session started there, issue 52), which are not this computer's to keep.
   */
  becomeSession(id: string, sessionId: string, controls: Controls | null) {
    drafts.set(`tab:${id}`, '');
    awaited.add(sessionId);
    const state = becomeSession(tabsView().state, id, sessionId);
    update(controls ? { state, remembered: remembered(controls) } : { state });
  },
  /**
   * The user picked a model, effort, fast mode or mode by hand (a session's controls, a new-session
   * draft, Settings): new sessions start with it from now on (Bypass excepted, see stickyPermission).
   * Modes a session inherits or a plan approval switches to never come through here.
   */
  chooseControls: (pick: StickyPick) => Object.keys(pick).length > 0 && update({ remembered: rememberPick(tabsView().remembered, pick) }),
  /** A preset was picked from the preset menu: remembered, so it shows as chosen even when another preset is the same. */
  choosePreset: (presetId: string) => tabsView().remembered.preset !== presetId && update({ remembered: rememberPreset(tabsView().remembered, presetId) }),
  /** The choices a new session starts with (Settings). */
  setDefaults: (controls: Controls) => update({ remembered: startFromOf(tabsView().remembered) === 'fixed' ? withFixed(remembered(controls), controls) : remembered(controls) }),
  /** Whether new sessions start with what was used last or always the same (Settings → General). */
  setStartFrom: (startFrom: StartFrom) => update({ remembered: withStartFrom(tabsView().remembered, startFrom) }),
  /** The sidebar was dragged to a new width. */
  setSidebarWidth: (px: number) => tabsView().sidebar.width !== clampWidth(px) && update({ sidebar: { ...tabsView().sidebar, width: clampWidth(px) } }),
  /** The tools column (files, browser, terminal) was dragged to a new width. */
  setPaneWidth: (px: number) => tabsView().sidebar.paneWidth !== clampPaneWidth(px) && update({ sidebar: { ...tabsView().sidebar, paneWidth: clampPaneWidth(px) } }),
  /** The session's changes column was dragged to a new width. */
  setChangesWidth: (px: number) => tabsView().sidebar.changesWidth !== clampPaneWidth(px) && update({ sidebar: { ...tabsView().sidebar, changesWidth: clampPaneWidth(px) } }),
  /** The Details pane was dragged to a new width. */
  setContextWidth: (px: number) => tabsView().sidebar.contextWidth !== clampContextWidth(px) && update({ sidebar: { ...tabsView().sidebar, contextWidth: clampContextWidth(px) } }),
  /** The bar between the Changes pane's file list and its diff was dragged; null goes back to the default (changes-split.ts). */
  setChangesListHeight(px: number | null): void {
    const { changesListHeight: old, ...rest } = tabsView().sidebar;
    const next = px === null ? undefined : clampChangesListHeight(px);
    if (old !== next) update({ sidebar: next === undefined ? rest : { ...rest, changesListHeight: next } });
  },
  /** The simulator column was dragged to a new width. */
  setSimWidth: (px: number) => tabsView().sidebar.simWidth !== clampSimWidth(px) && update({ sidebar: { ...tabsView().sidebar, simWidth: clampSimWidth(px) } }),
  /** A divider between stacked panes was dragged (or reset, with no weights), for one kind of page. */
  setStack(kind: ScopeKind, weights: StackWeights): void {
    const { [kind]: _old, ...rest } = tabsView().sidebar.stack ?? {};
    const stack = Object.keys(weights).length ? { ...rest, [kind]: weights } : rest;
    update({ sidebar: { ...tabsView().sidebar, stack } });
  },
  /** Mark a session as not looked at, or as looked at, by hand. */
  setUnread(sessionId: string, unread: boolean): void {
    asked = '';
    heldUnread = unread ? sessionId : heldUnread === sessionId ? null : heldUnread;
    void postSeen(unread ? { sessionIds: [sessionId], unread: true } : { sessionIds: [sessionId] });
  },
  /** Hide the sidebar, or show it again (⌘B). Remembered across restarts like its width. */
  toggleSidebar: () => update({ sidebar: toggleHidden(tabsView().sidebar) }),
  /** Collapse or expand a sidebar section or group. */
  toggleCollapsed: (key: string) => update({ sidebar: toggleCollapsed(tabsView().sidebar, key) }),
  /** Put a sidebar item beside another (or at the end); `present` is every item shown. */
  placeInSidebar: (present: readonly string[], moving: string, target: string | null, after = false) => update({ sidebar: { ...tabsView().sidebar, order: place(tabsView().sidebar.order, present, moving, target, after) } }),
  /** Put a project beside another (or at the end); `present` is every project shown. */
  placeProject: (present: readonly string[], moving: string, target: string | null, after = false) => update({ sidebar: placeProject(tabsView().sidebar, present, moving, target, after) }),
  /** Put a tag beside another (or at the end); `present` is every tag shown, as `tagKey` gives them. */
  placeTag: (present: readonly string[], moving: string, target: string | null, after = false) => update({ sidebar: placeTag(tabsView().sidebar, present, moving, target, after) }),
  /** Put a row of the sidebar's top menu beside another. */
  placeMenuItem: (moving: string, target: string, after = false) => update({ sidebar: placeMenuItem(tabsView().sidebar, moving, target, after) }),
  /** Put a workstream beside another (or at the end); `present` is every workstream shown. */
  placeWorkstream: (present: readonly string[], moving: string, target: string | null, after = false) => update({ sidebar: placeWorkstream(tabsView().sidebar, present, moving, target, after) }),
  /** Sort sessions in each sidebar list by most recent, or keep the dragged order (Settings → General). */
  setSessionOrder: (sessionOrder: SessionOrder) => update({ sidebar: { ...tabsView().sidebar, sessionOrder } }),
};

/** How sessions are ordered in the sidebar's lists: most recent unless the user chose custom. */
export const sessionOrderOf = (v: TabsView): SessionOrder => parseSessionOrder(v.sidebar.sessionOrder);
export const useSessionOrder = (): SessionOrder => useTabs(sessionOrderOf);

export const activeTab = (v: TabsView) => v.state.tabs.find((t) => t.id === v.state.activeId)!;
