// The sidebar's narrow-window state: whether it is drawn as the icon rail (derived from the
// window's width, shared/sidebar-mode.ts) and whether the full sidebar is floating open over the
// content from the rail. Nothing here is saved; the remembered width and hidden flag stay in
// tabsStore. The toggle button, ⌘B and the menu all go through `toggleSidebarOrFloat`.
import { useSyncExternalStore } from 'react';
import { SIDEBAR_WIDTH } from '@kestrel/server/sidebar';
import { panesMinWidth, sidebarMode, type SidebarMode } from '@kestrel/server/sidebar-mode';
import type { OpenPanes } from '@kestrel/server/pane-layout';
import { tabActions, tabsView, useTabs } from './tabsStore.ts';

interface RailState {
  windowWidth: number;
  /** The least room each mounted page's open side panes take, by scope. */
  panes: ReadonlyMap<string, number>;
  /** The full sidebar is open over the content (rail mode only). */
  floating: boolean;
}

let state: RailState = { windowWidth: typeof window === 'undefined' ? Infinity : window.innerWidth, panes: new Map(), floating: false };
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

const panesWidth = (s: RailState) => Math.max(0, ...s.panes.values());

/** The mode for the state given and the sidebar prefs as they are now. */
function modeOf(s: RailState): SidebarMode {
  const { width, hidden } = tabsView().sidebar;
  return sidebarMode({ windowWidth: s.windowWidth, sidebarWidth: width ?? SIDEBAR_WIDTH.initial, hidden: hidden === true, panesWidth: panesWidth(s) });
}

function set(patch: Partial<RailState>) {
  const next = { ...state, ...patch };
  // The floating sidebar belongs to the rail: once the full one fits again (or it is hidden), it is gone.
  state = next.floating && modeOf(next) !== 'rail' ? { ...next, floating: false } : next;
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') window.addEventListener('resize', () => window.innerWidth !== state.windowWidth && set({ windowWidth: window.innerWidth }));

/** A page reports the side panes it has open; `null` when it goes away. */
export function reportPanes(scopeKey: string, open: OpenPanes | null): void {
  const width = open ? panesMinWidth(open) : null;
  if (state.panes.get(scopeKey) === (width ?? undefined)) return;
  const panes = new Map(state.panes);
  if (width === null) panes.delete(scopeKey);
  else panes.set(scopeKey, width);
  set({ panes });
}

/** Full, rail or hidden, for the window as it is now. */
export function useSidebarMode(): SidebarMode {
  const width = useTabs((v) => v.sidebar.width ?? SIDEBAR_WIDTH.initial);
  const hidden = useTabs((v) => v.sidebar.hidden === true);
  const windowWidth = useSyncExternalStore(subscribe, () => state.windowWidth);
  const panes = useSyncExternalStore(subscribe, () => panesWidth(state));
  return sidebarMode({ windowWidth, sidebarWidth: width, hidden, panesWidth: panes });
}

/** Whether the full sidebar is floating open over the content. */
export const useSidebarFloating = (): boolean => useSyncExternalStore(subscribe, () => state.floating);

export const setSidebarFloating = (floating: boolean): void => {
  if (state.floating !== floating) set({ floating });
};

/** The toggle button and ⌘B: on the rail, open or close the floating sidebar; otherwise hide or show it. */
export function toggleSidebarOrFloat(): void {
  if (modeOf(state) === 'rail') setSidebarFloating(!state.floating);
  else tabActions.toggleSidebar();
}

/** Make the full sidebar visible (to rename a row in it): show it if hidden, float it if on the rail. */
export function revealSidebar(): void {
  if (tabsView().sidebar.hidden) tabActions.toggleSidebar();
  if (modeOf(state) === 'rail') setSidebarFloating(true);
}
