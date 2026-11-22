// Which sidebar row's menu a tab's right-click opens (Matt, 2026-11-22): a tab shows the same menu
// as the row of what it holds, so a session, project, group, tag, workstream, review request or the
// Overview offers the same actions wherever it is right-clicked. Pure, shared with the UI; the menu
// itself is built as for the row (ui/src/components/sidebarMenuTarget.ts, menu.ts).
import type { View } from './routes.ts';
import type { Tab } from './tabs.ts';

/** A row's menu, as a row names it in `data-menu-kind` and `data-menu-id`. */
export interface MenuRow {
  kind: 'overview' | 'session' | 'project' | 'folder' | 'tag' | 'workstream' | 'review';
  id: string;
}

/** The row whose menu a tab opens, or null for a tab with none (Settings, a new session, Pull requests). */
export function tabMenuRow(tab: Tab, view: View | null): MenuRow | null {
  if (tab.kind === 'session') return { kind: 'session', id: tab.sessionId };
  if (tab.kind !== 'page' || !view) return null;
  switch (view.kind) {
    case 'overview':
      return { kind: 'overview', id: '' };
    case 'project':
      return { kind: 'project', id: view.id };
    case 'group':
      return { kind: 'folder', id: view.id };
    case 'tag':
      return { kind: 'tag', id: view.id };
    case 'workstream':
      return { kind: 'workstream', id: view.id };
    case 'review-request':
      return { kind: 'review', id: view.id };
    default:
      return null;
  }
}
