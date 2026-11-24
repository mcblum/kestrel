// Where the side panes go, beside a session's conversation or a project or group page. Pure.
//
// Every toolbar icon turns its own pane on and off, and any combination can be open. Left to
// right after the main content: Context (a session's Details), Changes, the tools column (Files,
// Browser and Terminal stacked top to bottom, with a sub-agent's output above them), the
// Simulator. Context is a skinny fixed-width column nearest the main content as long as it fits
// beside the others (they give way first, down to their minimums); when it does not, it becomes
// a card floating over the main content on the columns' side, and the others keep their columns.
// Alone in a window too narrow for it as a column, it floats too: the main content stays usable.
// The main content keeps MAIN_MIN_WIDTH. When the columns do not fit beside it they give way
// first: Changes, then the tools column, then the Simulator, each down to its minimum; then the
// main content gives way, down to MAIN_SQUEEZED_WIDTH (2026-11-19: a 900px window with the tools
// column and the Simulator open drew the Simulator past the window's edge); only then does the
// pane area scroll sideways inside itself, with a scroll bar that shows. The widths the user dragged to are not
// changed by this, so they apply again once there is room. No single column is ever wider than
// the room beside the main content, so one column alone never runs past the window.
import type { ScopeKind } from './scope.ts';

export type PaneId = 'changes' | 'files' | 'commands' | 'terminal' | 'browser' | 'simulator' | 'context';
/**
 * What can stack in the tools column. `agent` is one sub-agent's output and `aside` one sidebar
 * about a finding (shared/asides.ts), each opened from the conversation.
 */
export type StackPane = 'aside' | 'agent' | 'files' | 'browser' | 'commands' | 'terminal';
export type ColumnId = 'changes' | 'tools' | 'simulator' | 'context';

export type OpenPanes = Readonly<Record<PaneId | 'agent' | 'aside', boolean>>;
export const NO_PANES: OpenPanes = { changes: false, files: false, commands: false, terminal: false, browser: false, simulator: false, context: false, agent: false, aside: false };

export const MAIN_MIN_WIDTH = 420;
/** The least the main content keeps once every column is at its minimum and they still do not fit beside it. */
export const MAIN_SQUEEZED_WIDTH = 300;
/** The Details pane (Context): narrow by default, and it can be dragged wider (Matt, 2026-11-18). */
export const CONTEXT_WIDTH_LIMITS = { min: 240, max: 560, initial: 264 } as const;
export const CONTEXT_WIDTH = CONTEXT_WIDTH_LIMITS.initial;
/** Changes and the tools column. */
export const PANE_WIDTH = { min: 280, max: 1100, initial: 460 } as const;
/** About a phone's width. */
export const SIM_WIDTH = { min: 260, max: 900, initial: 360 } as const;
/** Top to bottom: the terminal sits at the bottom, as in an IDE, with the session's commands just above it. */
export const STACK_ORDER: readonly StackPane[] = ['aside', 'agent', 'files', 'browser', 'commands', 'terminal'];
/** A stacked pane is never squeezed below this many pixels by a divider. */
export const STACK_MIN_HEIGHT = 80;

const LIMITS = { changes: PANE_WIDTH, tools: PANE_WIDTH, simulator: SIM_WIDTH, context: CONTEXT_WIDTH_LIMITS } as const;
type Resizable = keyof typeof LIMITS;

export interface ColumnWidths {
  changes?: number;
  tools?: number;
  simulator?: number;
  context?: number;
}

export interface LayoutColumn {
  id: ColumnId;
  width: number;
}

export interface PaneLayout {
  /** The columns beside the main content, left to right, with the widths to draw them at. */
  columns: LayoutColumn[];
  /** What the tools column stacks, top to bottom (empty when it is closed). */
  stack: StackPane[];
  /** Context is open but floats as a card over the main content. */
  contextFloats: boolean;
  /** The least the main content is drawn at: MAIN_MIN_WIDTH, or less (not below MAIN_SQUEEZED_WIDTH) when the columns need it. */
  mainMin: number;
  /** The width everything needs: the main content's least width plus every column. */
  needed: number;
  /** The columns do not fit beside the main content: the pane area scrolls sideways. */
  overflows: boolean;
}

const clamp = (px: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, px)));
const usable = (px: unknown): px is number => typeof px === 'number' && Number.isFinite(px);

/** A dragged width held inside a column's limits (not yet the window's). */
export const clampColumnWidth = (column: Resizable, px: number): number => clamp(px, LIMITS[column].min, LIMITS[column].max);

/**
 * The layout for the panes that are open, given the width the page has (main content and
 * columns together) and the widths the user dragged the columns to.
 */
export function paneLayout(open: OpenPanes, available: number, widths: ColumnWidths = {}): PaneLayout {
  const stack = STACK_ORDER.filter((p) => open[p]);
  const besideMain = Math.max(0, Math.floor(available) - MAIN_MIN_WIDTH);
  const width = (id: Resizable) => {
    const { min, max, initial } = LIMITS[id];
    const wanted = usable(widths[id]) ? widths[id] : initial;
    // Never wider than the room beside the main content; never narrower than the column's minimum.
    return clamp(wanted, min, Math.max(min, Math.min(max, besideMain)));
  };
  const wanted: LayoutColumn[] = [];
  if (open.changes) wanted.push({ id: 'changes', width: width('changes') });
  if (stack.length) wanted.push({ id: 'tools', width: width('tools') });
  if (open.simulator) wanted.push({ id: 'simulator', width: width('simulator') });
  // Context comes first, beside the main content, if everything still fits with it there. It is
  // never squeezed to fit: at the width it was dragged to it stands as a column, or it floats.
  const withContext = open.context ? giveWay([{ id: 'context', width: contextCardWidth(widths.context) }, ...wanted], besideMain) : null;
  const fits = withContext !== null && totalWidth(withContext) <= besideMain;
  const contextFloats = open.context && !fits;
  const columns = fits ? withContext : giveWay(wanted, besideMain);
  const mainMin = squeezedMain(available, totalWidth(columns));
  const needed = mainMin + totalWidth(columns);
  return { columns, stack, contextFloats, mainMin, needed, overflows: needed > available };
}

/**
 * The main content's least width beside columns this wide: its minimum, or what is left of the
 * page, not below MAIN_SQUEEZED_WIDTH. With no columns it is not squeezed: there is nothing to make room for.
 */
const squeezedMain = (available: number, columns: number): number =>
  columns > 0 ? Math.max(MAIN_SQUEEZED_WIDTH, Math.min(MAIN_MIN_WIDTH, Math.floor(available) - columns)) : MAIN_MIN_WIDTH;

/** Whether anything stacks in the tools column. */
export const toolsOpen = (open: OpenPanes): boolean => STACK_ORDER.some((p) => open[p]);

const totalWidth = (columns: readonly LayoutColumn[]) => columns.reduce((sum, c) => sum + c.width, 0);

/** Which columns give way first when they do not all fit beside the main content. */
const SHRINK_ORDER: readonly Resizable[] = ['changes', 'tools', 'simulator'];

/** Narrow the columns, in SHRINK_ORDER and each down to its minimum, until they fit in `room` (or cannot shrink further). */
function giveWay(columns: readonly LayoutColumn[], room: number): LayoutColumn[] {
  let excess = totalWidth(columns) - room;
  if (excess <= 0) return [...columns];
  const narrowed = new Map<ColumnId, number>();
  for (const id of SHRINK_ORDER) {
    const column = columns.find((c) => c.id === id);
    if (!column || excess <= 0) continue;
    const cut = Math.min(excess, column.width - LIMITS[id].min);
    if (cut <= 0) continue;
    narrowed.set(id, column.width - cut);
    excess -= cut;
  }
  return columns.map((c) => (narrowed.has(c.id) ? { ...c, width: narrowed.get(c.id)! } : c));
}

/** Turn one pane on or off. Files, Browser and Terminal no longer close each other; a sub-agent's output stays until closed. */
export const togglePane = (open: OpenPanes, pane: PaneId): OpenPanes => ({ ...open, [pane]: !open[pane] });

// ---- the stacked panes' heights ------------------------------------------------------------

/** Relative heights of the stacked panes; a pane with no entry has weight 1. */
export type StackWeights = Partial<Record<StackPane, number>>;
/** Kept per page kind: a session's stack and a project page's can differ. */
export type StackSizes = Partial<Record<ScopeKind, StackWeights>>;

const WEIGHT = { min: 0.05, max: 20 } as const;

/** Each stacked pane's share of the column, adding up to 1. */
export function stackShares(stack: readonly StackPane[], weights: StackWeights = {}): number[] {
  const raw = stack.map((p) => (usable(weights[p]) && weights[p]! > 0 ? weights[p]! : 1));
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => (total > 0 ? w / total : 1 / stack.length));
}

/**
 * The weights after the divider below `stack[index]` moved `dy` pixels, in a column whose
 * stacked panes are `height` pixels tall together. Only the two panes beside the divider change;
 * neither goes below STACK_MIN_HEIGHT (or below an even share when the column is too short for that).
 */
export function dragDivider(stack: readonly StackPane[], weights: StackWeights, index: number, dy: number, height: number): StackWeights {
  const above = stack[index];
  const below = stack[index + 1];
  if (!above || !below || !(height > 0) || !Number.isFinite(dy)) return weights;
  const shares = stackShares(stack, weights);
  const pair = (shares[index]! + shares[index + 1]!) * height;
  const floor = Math.min(STACK_MIN_HEIGHT, pair / 2);
  const top = clamp(shares[index]! * height + dy, floor, pair - floor);
  const next: StackWeights = {};
  stack.forEach((p, i) => (next[p] = shares[i]!));
  next[above] = top / height;
  next[below] = (pair - top) / height;
  return next;
}

/** Stored stack sizes, as far as they make sense: unknown kinds and panes and odd numbers are dropped. */
export function sanitizeStackSizes(value: unknown): StackSizes | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: StackSizes = {};
  for (const kind of ['session', 'project', 'group'] as const) {
    const entry = (value as Record<string, unknown>)[kind];
    if (typeof entry !== 'object' || entry === null) continue;
    const weights: StackWeights = {};
    for (const pane of STACK_ORDER) {
      const w = (entry as Record<string, unknown>)[pane];
      if (usable(w) && w > 0) weights[pane] = Math.min(WEIGHT.max, Math.max(WEIGHT.min, w));
    }
    if (Object.keys(weights).length) out[kind] = weights;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The Details pane's width when it floats as a card: what it was dragged to, inside its limits. */
export const contextCardWidth = (wanted: number | undefined): number => clampColumnWidth('context', usable(wanted) ? wanted : CONTEXT_WIDTH_LIMITS.initial);
