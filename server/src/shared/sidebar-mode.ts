// Whether the sidebar is drawn full, as a narrow icon rail, or not at all, and what the rail lists.
// Pure. The rail is derived from the window's width every time: it never changes the width the
// user dragged the sidebar to, nor whether they hid it (⌘B). Hidden wins; otherwise the full
// sidebar is drawn whenever the window fits it beside the main content and the side panes open
// on the page in front, each at its minimum, and the rail is drawn when it does not.
import { MAIN_MIN_WIDTH, PANE_WIDTH, SIM_WIDTH, toolsOpen, type OpenPanes } from './pane-layout.ts';

export type SidebarMode = 'full' | 'rail' | 'hidden';

/** How wide the rail is drawn: one icon button and its margins. */
export const RAIL_WIDTH = 48;
/** The main content's minimum beside the sidebar; the same minimum the side panes leave it. */
export const MAIN_AREA_MIN = MAIN_MIN_WIDTH;
/** At most this many sessions are listed on the rail; the rest are a click on the toggle away. */
export const RAIL_MAX_SESSIONS = 12;

export interface SidebarModeInput {
  /** The window's inner width. */
  windowWidth: number;
  /** The width the user gave the full sidebar. */
  sidebarWidth: number;
  /** The user hid the sidebar (⌘B). */
  hidden: boolean;
  /** The least room the side panes open on the page in front take (panesMinWidth). */
  panesWidth?: number;
}

/**
 * The least room the open side panes need beside the main content: each column at its minimum.
 * Context is left out, because it floats over the main content when there is no room for it.
 */
export function panesMinWidth(open: OpenPanes): number {
  // Anything that stacks in the tools column counts, Commands too (2026-11-19: left out, it kept the
  // full sidebar beside a Commands pane that then ran past a 900px window).
  return (open.changes ? PANE_WIDTH.min : 0) + (toolsOpen(open) ? PANE_WIDTH.min : 0) + (open.simulator ? SIM_WIDTH.min : 0);
}

/** Full when the window fits the sidebar, the main content and the open panes; the rail when not. */
export function sidebarMode({ windowWidth, sidebarWidth, hidden, panesWidth = 0 }: SidebarModeInput): SidebarMode {
  if (hidden) return 'hidden';
  const needed = sidebarWidth + MAIN_AREA_MIN + Math.max(0, panesWidth);
  return windowWidth >= needed ? 'full' : 'rail';
}

export interface RailSession {
  id: string;
  /** What is waiting for the user there (shared/unread.ts). */
  dot: 'needs-you' | 'unread' | 'working' | 'none';
}

/**
 * The sessions the rail lists: the pinned ones in PINNED's order, then those waiting for an answer
 * that are not pinned, in the order given; each once, at most RAIL_MAX_SESSIONS.
 */
export function railSessions(pinned: readonly RailSession[], all: readonly RailSession[], max = RAIL_MAX_SESSIONS): RailSession[] {
  const pinnedIds = new Set(pinned.map((s) => s.id));
  const waiting = all.filter((s) => s.dot === 'needs-you' && !pinnedIds.has(s.id));
  const seen = new Set<string>();
  const unique = [...pinned, ...waiting].filter((s) => !seen.has(s.id) && (seen.add(s.id), true));
  return unique.slice(0, Math.max(0, max));
}
