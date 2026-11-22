// Back and forward in this window (server: shared/nav-history.ts). Watches what is in front
// (the tabs slice of the app store) and records each new place; a step back or forward opens
// that place the way any click would (`tabActions.open`: the tab already showing it is brought
// forward, otherwise it is shown in the tab in front). Kept for the window only: not server data,
// and gone on reload, like a scroll position.
import { useSyncExternalStore } from 'react';
import { canStep, currentPlace, EMPTY_HISTORY, placeOf, samePlace, step, visit, type NavHistory, type Place } from '@kestrel/server/nav-history';
import { appStore } from './store.ts';
import { tabActions, tabsView } from './tabsStore.ts';

let history: NavHistory = EMPTY_HISTORY;
const listeners = new Set<() => void>();

function set(next: NavHistory): void {
  if (next === history) return;
  history = next;
  for (const listener of listeners) listener();
}

const placeInFront = (): Place | null => {
  const { state, loaded } = tabsView();
  return loaded ? placeOf(state.tabs.find((t) => t.id === state.activeId)) : null;
};

/** A session that is no longer in the workspace cannot be gone back to; a page always can. */
function stillThere(place: Place): boolean {
  if (place.kind === 'page') return true;
  const ws = appStore.get().workspace;
  return !ws || ws.sessions.some((s) => s.id === place.sessionId) || ws.archived.sessions.some((s) => s.id === place.sessionId);
}

/** Every change of what is in front is a visit, a step's own included: `visit` ignores the place already current. */
function record(): void {
  const place = placeInFront();
  if (place) set(visit(history, place));
}

/**
 * What is in front is not a place (an unsent New session screen), so the place the user was last
 * at is behind it: Back returns there, not to the one before it.
 */
function behindFront(): Place | null {
  const current = currentPlace(history);
  return current && tabsView().loaded && !samePlace(placeInFront(), current) && stillThere(current) ? current : null;
}

function go(direction: -1 | 1): void {
  const behind = direction === -1 ? behindFront() : null;
  if (behind) return tabActions.open(behind);
  const next = step(history, direction, stillThere);
  if (!next) return;
  const before = history;
  // Moved first, so the tab change that follows is seen as the place already current, not a new visit.
  set(next.history);
  tabActions.open(next.place);
  // The user kept their unsaved changes (the leave guard), or the place could not be shown: stay where we were.
  if (!samePlace(placeInFront(), next.place)) set(before);
}

export const goBack = (): void => go(-1);
export const goForward = (): void => go(1);

// What is in front changes with the tabs as well as with the history, and decides whether Back has somewhere to go.
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const offStore = appStore.subscribe(listener);
  return () => {
    listeners.delete(listener);
    offStore();
  };
};
export const useCanGoBack = (): boolean => useSyncExternalStore(subscribe, () => behindFront() !== null || canStep(history, -1, stillThere));
export const useCanGoForward = (): boolean => useSyncExternalStore(subscribe, () => canStep(history, 1, stillThere));
/** For tests and debugging. */
export const navHistoryNow = (): NavHistory => history;
export const placeNow = (): Place | null => currentPlace(history);

/** Start recording. Called once, as the app starts. The mouse's back and forward buttons step too. */
export function installNavHistory(): void {
  appStore.subscribe(record);
  record();
  window.addEventListener('mouseup', (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    go(event.button === 3 ? -1 : 1);
  });
}
