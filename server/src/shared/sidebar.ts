// How the sidebar is arranged: the order the user dragged things into, and what is collapsed.
// Pure. The order is one list of ids (groups and top-level sessions together); projects have
// their own list. Anything not in an order yet is new and goes first.

import { clampColumnWidth, PANE_WIDTH, sanitizeStackSizes, type StackSizes } from './pane-layout.ts';
import type { SessionOrder } from './session-order.ts';

export { PANE_WIDTH };

export interface SidebarPrefs {
  /** Group ids and root session ids, in the order the user left them. */
  order: string[];
  /** Project ids, in the order the user dragged them. Absent in prefs stored before it existed. */
  projectOrder?: string[];
  /** Tags (lowercased, as `tagKey` gives them), in the order the user dragged them. Absent in prefs stored before it existed. */
  tagOrder?: string[];
  /** Workstream ids, in the order the user dragged them. Absent in prefs stored before workstreams existed. */
  workstreamOrder?: string[];
  /** The top menu's rows (`MENU_ITEMS`), in the order the user dragged them. Absent until one is dragged. */
  menuOrder?: string[];
  /** Collapsed things: `sessions`, `projects`, or a group id. */
  collapsed: string[];
  /** Sidebar width in pixels, when the user has dragged it. */
  width?: number;
  /** Width of the session's files-and-terminal column, when dragged. */
  paneWidth?: number;
  /** Width of the session's changes column, when dragged. */
  changesWidth?: number;
  /** The Details pane's width, once dragged. */
  contextWidth?: number;
  /** Width of the simulator column, when dragged. Absent in prefs stored before it existed. */
  simWidth?: number;
  /** Heights of the panes stacked in the tools column, per page kind, when dragged. */
  stack?: StackSizes;
  /** The sidebar is hidden (⌘B); the main area takes the full width. Absent means shown. */
  hidden?: boolean;
  /**
   * How sessions are ordered inside each list (shared/session-order.ts). Absent means most recent.
   * `order` is kept either way, so choosing custom again brings back the order last dragged.
   */
  sessionOrder?: SessionOrder;
}

/** The rows of the sidebar's top menu, in the order Kestrel ships them (Matt, 2026-11-22: they can be dragged into another). */
export const MENU_ITEMS = ['overview', 'new-session', 'pull-requests', 'code-reviews', 'tickets'] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];
const isMenuItem = (id: string): id is MenuItem => (MENU_ITEMS as readonly string[]).includes(id);

export const EMPTY_SIDEBAR: SidebarPrefs = { order: [], collapsed: [] };
export const SIDEBAR_WIDTH = { min: 200, max: 520, initial: 252 } as const;

/** A dragged width held inside the limits. */
export const clampWidth = (px: number): number => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, px)));

export const clampPaneWidth = (px: number): number => clampColumnWidth('tools', px);
/** The Details pane's width, inside its limits. */
export const clampContextWidth = (px: number): number => clampColumnWidth('context', px);
export const clampSimWidth = (px: number): number => clampColumnWidth('simulator', px);
const MAX_IDS = 5000;

const strings = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200))].slice(0, MAX_IDS) : []);

export function sanitizeSidebar(value: unknown): SidebarPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const width = typeof v.width === 'number' && Number.isFinite(v.width) ? { width: clampWidth(v.width) } : {};
  const paneWidth = typeof v.paneWidth === 'number' && Number.isFinite(v.paneWidth) ? { paneWidth: clampPaneWidth(v.paneWidth) } : {};
  const changesWidth = typeof v.changesWidth === 'number' && Number.isFinite(v.changesWidth) ? { changesWidth: clampPaneWidth(v.changesWidth) } : {};
  const contextWidth = typeof v.contextWidth === 'number' && Number.isFinite(v.contextWidth) ? { contextWidth: clampColumnWidth('context', v.contextWidth) } : {};
  const simWidth = typeof v.simWidth === 'number' && Number.isFinite(v.simWidth) ? { simWidth: clampSimWidth(v.simWidth) } : {};
  const stackSizes = sanitizeStackSizes(v.stack);
  const stack = stackSizes ? { stack: stackSizes } : {};
  const projectOrder = Array.isArray(v.projectOrder) ? { projectOrder: strings(v.projectOrder) } : {};
  const tagOrder = Array.isArray(v.tagOrder) ? { tagOrder: strings(v.tagOrder) } : {};
  const workstreamOrder = Array.isArray(v.workstreamOrder) ? { workstreamOrder: strings(v.workstreamOrder) } : {};
  const menuOrder = Array.isArray(v.menuOrder) ? { menuOrder: strings(v.menuOrder).filter(isMenuItem) } : {};
  const hidden = v.hidden === true ? { hidden: true } : {};
  // Checked here rather than with session-order.ts's list, which imports this file.
  const sessionOrder = v.sessionOrder === 'recent' || v.sessionOrder === 'custom' ? { sessionOrder: v.sessionOrder as SessionOrder } : {};
  return { order: strings(v.order), ...projectOrder, ...tagOrder, ...workstreamOrder, ...menuOrder, collapsed: strings(v.collapsed), ...width, ...paneWidth, ...changesWidth, ...contextWidth, ...simWidth, ...stack, ...hidden, ...sessionOrder };
}

/** Items in the user's order. Items the order does not know are new: they come first, as given. */
export function arrange<T>(items: readonly T[], idOf: (item: T) => string, order: readonly string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const fresh = items.filter((x) => !rank.has(idOf(x)));
  const known = items.filter((x) => rank.has(idOf(x))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  return [...fresh, ...known];
}

/**
 * The order after `moving` is dropped beside `target` (before it, or after it), or at the end
 * when there is no target. `present` is every id shown now, so the result is a complete order.
 */
export function place(order: readonly string[], present: readonly string[], moving: string, target: string | null, after = false): string[] {
  const rest = arrange(present, (id) => id, order).filter((id) => id !== moving);
  const at = target === null || target === moving ? -1 : rest.indexOf(target);
  const index = at === -1 ? rest.length : at + (after ? 1 : 0);
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}

/**
 * Every top menu row, in the user's order. A row the saved order does not know (one added to Kestrel
 * since it was dragged) goes after the ones it does, in the shipped order, so it never jumps to the top.
 */
export function menuOrder(prefs: SidebarPrefs): MenuItem[] {
  const saved = (prefs.menuOrder ?? []).filter(isMenuItem);
  return [...saved, ...MENU_ITEMS.filter((id) => !saved.includes(id))];
}

/** The prefs after top menu row `moving` is dropped beside row `target`. */
export function placeMenuItem(prefs: SidebarPrefs, moving: string, target: string, after = false): SidebarPrefs {
  if (!isMenuItem(moving) || !isMenuItem(target) || moving === target) return prefs;
  const rest = menuOrder(prefs).filter((id) => id !== moving);
  const index = rest.indexOf(target) + (after ? 1 : 0);
  return { ...prefs, menuOrder: [...rest.slice(0, index), moving, ...rest.slice(index)] };
}

/** The prefs after project `moving` is dropped beside project `target`; `present` is every project shown. */
export function placeProject(prefs: SidebarPrefs, present: readonly string[], moving: string, target: string | null, after = false): SidebarPrefs {
  return { ...prefs, projectOrder: place(prefs.projectOrder ?? [], present, moving, target, after) };
}

/** The prefs after tag `moving` is dropped beside tag `target`; `present` is every tag shown. Tags are given as `tagKey` gives them. */
export function placeTag(prefs: SidebarPrefs, present: readonly string[], moving: string, target: string | null, after = false): SidebarPrefs {
  return { ...prefs, tagOrder: place(prefs.tagOrder ?? [], present, moving, target, after) };
}

/** The prefs after workstream `moving` is dropped beside workstream `target`; `present` is every workstream shown. */
export function placeWorkstream(prefs: SidebarPrefs, present: readonly string[], moving: string, target: string | null, after = false): SidebarPrefs {
  return { ...prefs, workstreamOrder: place(prefs.workstreamOrder ?? [], present, moving, target, after) };
}

export function toggleCollapsed(prefs: SidebarPrefs, key: string): SidebarPrefs {
  return { ...prefs, collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key] };
}

/** The prefs with the sidebar shown if it was hidden, hidden if it was shown. Shown is stored as no flag. */
export function toggleHidden(prefs: SidebarPrefs): SidebarPrefs {
  const { hidden, ...rest } = prefs;
  return hidden ? rest : { ...rest, hidden: true };
}
