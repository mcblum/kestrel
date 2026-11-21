// Page routes, as stored in a page tab's path (`#/project/x`). Pure and browser-safe: the UI's
// route.ts builds on these, and the sidebar asks `selectsRow` which row the open page belongs to.
import { DEFAULT_REQUEST_FILTER, isRequestFilter, type RequestFilter } from './pull-request-list.ts';

/** A project page's local tabs. Sessions is the default and has no path of its own. */
export type ProjectTab = 'sessions' | 'settings';
/** The sections of a project's Settings tab, in menu order; a path selects the visible section. */
export const PROJECT_SECTIONS = ['general', 'folders', 'git', 'actions', 'scripts', 'environment', 'agent-setup'] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

export type View =
  | { kind: 'overview' }
  | { kind: 'attention' }
  /** The workspace's Pull requests page; `filter` is the chip chosen, kept in the path (none for the default, Open). */
  | { kind: 'pull-requests'; filter?: RequestFilter }
  | { kind: 'all'; filter?: 'done' }
  | { kind: 'unscoped' }
  | { kind: 'settings'; section?: string }
  /** `groupId`: the project's group the session was dropped on, which the new session joins. */
  | { kind: 'move'; sessionId: string; projectId: string; groupId?: string }
  | { kind: 'group'; id: string }
  /** `tab: 'settings'` is the project's Settings tab, `section` the part of it to show. */
  | { kind: 'project'; id: string; tab?: 'settings'; section?: ProjectSection }
  | { kind: 'tag'; id: string }
  /** A workstream's page: what the work is for, its sessions, and what needs the user. */
  | { kind: 'workstream'; id: string }
  /** The Code reviews page: every request the user was asked to review; `filter: 'dismissed'` is the ones they dismissed. */
  | { kind: 'code-reviews'; filter?: 'dismissed' }
  /** A request the user was asked to review, by its key (shared/review-requests.ts). */
  | { kind: 'review-request'; id: string }
  /** Create project; `from: 'folder'` is its second way in, several projects from one parent folder. */
  | { kind: 'new-project'; from?: 'folder' }
  /** One code block of a conversation, whole: the message it is in and where its fence starts (shared/code-ref.ts). */
  | { kind: 'code'; sessionId: string; messageId: string; at: number };

export type ProjectView = Extract<View, { kind: 'project' }>;

export const OVERVIEW_VIEW: View = { kind: 'overview' };

/** The Pull requests page with a filter chosen; the default filter is no filter in the path. */
export const pullRequestsView = (filter?: RequestFilter): View => (filter && filter !== DEFAULT_REQUEST_FILTER ? { kind: 'pull-requests', filter } : { kind: 'pull-requests' });

/** A project's Settings tab, optionally at one section. */
export const projectSettings = (id: string, section?: ProjectSection): ProjectView => (section ? { kind: 'project', id, tab: 'settings', section } : { kind: 'project', id, tab: 'settings' });

const isSection = (s: string | undefined): s is ProjectSection => (PROJECT_SECTIONS as readonly string[]).includes(s ?? '');

/** Old project settings in the global Settings page (`#/settings/project:<id>`). */
const OLD_PROJECT_SETTINGS = 'project:';

function parseProject(id: string, c: string | undefined, d: string | undefined): View {
  // `…/folders` was the folders page (2026-11-15); it is now the Settings tab's Folders section.
  if (c === 'folders') return projectSettings(id, 'folders');
  if (c === 'settings') return projectSettings(id, isSection(d) ? d : undefined);
  return { kind: 'project', id };
}

/** The view a path names; anything unknown is the Overview. */
export function parseViewPath(path: string): View {
  const [, a, b, c, d] = path.replace(/^#/, '').split('/');
  const id = b ? decodeURIComponent(b) : '';
  if (a === 'project' && id) return parseProject(id, c, d);
  if (a === 'group' && id) return { kind: 'group', id };
  if (a === 'tag' && id) return { kind: 'tag', id };
  if (a === 'workstream' && id) return { kind: 'workstream', id };
  if (a === 'review-request' && id) return { kind: 'review-request', id };
  if (a === 'settings' && id.startsWith(OLD_PROJECT_SETTINGS) && id.length > OLD_PROJECT_SETTINGS.length) return projectSettings(id.slice(OLD_PROJECT_SETTINGS.length), 'agent-setup');
  if (a === 'settings') return id ? { kind: 'settings', section: id } : { kind: 'settings' };
  if (a === 'move' && id && c) return { kind: 'move', sessionId: id, projectId: decodeURIComponent(c), ...(d ? { groupId: decodeURIComponent(d) } : {}) };
  if (a === 'code' && id && c && /^\d+$/.test(d ?? '')) return { kind: 'code', sessionId: id, messageId: decodeURIComponent(c), at: Number(d) };
  if (a === 'new-project') return b === 'folder' ? { kind: 'new-project', from: 'folder' } : { kind: 'new-project' };
  if (a === 'pull-requests') return pullRequestsView(isRequestFilter(b) ? b : undefined);
  if (a === 'code-reviews') return b === 'dismissed' ? { kind: 'code-reviews', filter: 'dismissed' } : { kind: 'code-reviews' };
  if (a === 'all' && b === 'done') return { kind: 'all', filter: 'done' };
  if (a === 'attention' || a === 'all' || a === 'unscoped') return { kind: a };
  return OVERVIEW_VIEW;
}

/** The path of a view, the inverse of `parseViewPath`. */
export function viewPath(view: View): string {
  if (view.kind === 'project' && view.tab === 'settings') return `#/project/${encodeURIComponent(view.id)}/settings${view.section ? `/${view.section}` : ''}`;
  if (view.kind === 'group' || view.kind === 'project' || view.kind === 'tag' || view.kind === 'workstream' || view.kind === 'review-request') return `#/${view.kind}/${encodeURIComponent(view.id)}`;
  if (view.kind === 'settings') return view.section ? `#/settings/${encodeURIComponent(view.section)}` : '#/settings';
  if (view.kind === 'move') return `#/move/${encodeURIComponent(view.sessionId)}/${encodeURIComponent(view.projectId)}${view.groupId ? `/${encodeURIComponent(view.groupId)}` : ''}`;
  if (view.kind === 'code') return `#/code/${encodeURIComponent(view.sessionId)}/${encodeURIComponent(view.messageId)}/${view.at}`;
  if ((view.kind === 'all' || view.kind === 'code-reviews') && view.filter) return `#/${view.kind}/${view.filter}`;
  if (view.kind === 'pull-requests') return view.filter ? `#/pull-requests/${view.filter}` : '#/pull-requests';
  if (view.kind === 'new-project' && view.from) return `#/new-project/${view.from}`;
  return view.kind === 'overview' ? '#/' : `#/${view.kind}`;
}

/**
 * The destination a view belongs to, without its local tab: what names the workspace tab and which
 * sidebar row is selected. A project is the same destination on its Sessions and Settings tabs, the
 * Pull requests and Code reviews pages under every filter.
 */
export function containerOf(view: View): View {
  if (view.kind === 'all') return { kind: 'all' };
  if (view.kind === 'pull-requests') return { kind: 'pull-requests' };
  if (view.kind === 'code-reviews') return { kind: 'code-reviews' };
  if (view.kind === 'new-project') return { kind: 'new-project' };
  return view.kind === 'project' ? { kind: 'project', id: view.id } : view;
}

/** The local tab a project view shows. */
export const projectTabOf = (view: View): ProjectTab => (view.kind === 'project' && view.tab === 'settings' ? 'settings' : 'sessions');

/** Whether the open page `open` makes the sidebar row for `row` look selected. */
export function selectsRow(open: View | null, row: View): boolean {
  if (!open) return false;
  const page = containerOf(open);
  if (page.kind !== row.kind) return false;
  return !('id' in row) || ('id' in page && page.id === row.id);
}
