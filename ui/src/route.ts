// Where each tab is. A page tab stores its route as a path (`#/project/x`), so it survives a
// reload and two tabs can show two pages. The page shown is the one in the tab in front.
import type { MouseEvent } from 'react';
import { OVERVIEW_PATH, type Tab } from '@kestrel/server/tabs';
import { tabActions, tabsView, type TabsView } from './tabsStore.ts';
import { OVERVIEW_VIEW, parseViewPath, viewPath, type View } from '@kestrel/server/routes';

export type { View };
export type Route = { screen: 'list'; view: View };

const OVERVIEW: Route = { screen: 'list', view: OVERVIEW_VIEW };

const parse = (path: string): Route => ({ screen: 'list', view: parseViewPath(path) });

export const pathFor = viewPath;

// Parsed once per path, so a selector returns the same object until the path changes.
const parsed = new Map<string, Route>();
export function routeOf(path: string): Route {
  let route = parsed.get(path);
  if (!route) parsed.set(path, (route = parse(path)));
  return route;
}

/** The page in a tab; a session or unsent tab shows none. */
export const tabRoute = (tab: Tab | undefined): Route | null => (tab?.kind === 'page' ? routeOf(tab.path) : null);
const activeRoute = (v: TabsView): Route | null => tabRoute(v.state.tabs.find((t) => t.id === v.state.activeId));

/** The page in the tab in front, or Overview when that tab is a session. */
export const currentRoute = (): Route => activeRoute(tabsView()) ?? OVERVIEW;

// ---- opening things: every click that navigates comes through here -------------------------

/** Show a session: in the tab in front, in a tab already showing it, or (`newTab`) in a new tab. */
export const openSession = (id: string, newTab = false) => tabActions.open({ kind: 'session', sessionId: id }, newTab);
/** Show the page of every session with a tag. */
export const openTag = (tag: string, newTab = false) => openView({ kind: 'tag', id: tag }, newTab);
/** Show a page the same way. */
export const openView = (view: View, newTab = false) => tabActions.open({ kind: 'page', path: pathFor(view) }, newTab);

/** Switch a local tab of the page in front (a project's Sessions or Settings) without a new workspace tab. */
export const showLocal = (view: View) => tabActions.showInPlace(pathFor(view));

/** Shift-click or Cmd/Ctrl-click asks for a new tab. */
export const wantsNewTab = (event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>) => event.shiftKey || event.metaKey || event.ctrlKey;

/** Click handlers for anything that navigates: a plain click opens here; shift, Cmd or a middle click in a new tab. */
export function opener(open: (newTab: boolean) => void) {
  return {
    onClick: (event: MouseEvent) => open(wantsNewTab(event)),
    onAuxClick: (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      open(true);
    },
  };
}
