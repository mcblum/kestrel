// Where a popup goes so that all of it stays inside the window. One rule for every menu, picker,
// card and tooltip in the UI (ui/src/components/usePopupPlacement.ts measures and applies it):
//
// - It opens on its preferred side of what it hangs from (below, above, right or left) when that
//   side has room, else on the opposite side when that one has room.
// - Along that side it lines up with the anchor (start, end or centre). Below or above, when the
//   preferred alignment runs past the window's edge it takes the other one (a menu under a button
//   near the right edge lines up with the button's right edge); beside (a submenu) it stays level
//   with its item. Either way it is then shifted to stay inside.
// - When neither side has room it overlaps the anchor, shifted inside the window; when it is
//   larger than the window it is capped to the window and scrolls inside.
//
// The window is the viewport less a margin on every side, plus `topInset` at the top (the
// draggable title-bar strip in the desktop app, where a popup must not sit).

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The side of the anchor the popup opens on. */
export type Side = 'below' | 'above' | 'right' | 'left';
/** How the popup lines up with the anchor along that side: its start (left or top) edge, its end edge, or centred. */
export type Align = 'start' | 'end' | 'center';

export interface PlaceRequest {
  /** What the popup hangs from, in window coordinates. A point (a right-click) is a rect of no size. */
  anchor: Rect;
  /** The popup's natural size, measured with no cap. */
  size: Size;
  viewport: Size;
  side: Side;
  align?: Align;
  /** Space between the anchor and the popup. */
  gap?: number;
  /** Space kept free at every edge of the window. */
  margin?: number;
  /** Extra space kept free at the top (the title-bar strip). */
  topInset?: number;
}

export interface Placement {
  left: number;
  top: number;
  /** The side it ended up on (a flipped submenu opens its own submenus the same way). */
  side: Side;
  /** Set when the popup is taller than the window allows: cap it and let it scroll. */
  maxHeight?: number;
  /** Set when the popup is wider than the window allows. */
  maxWidth?: number;
}

export const POPUP_MARGIN = 8;

const OPPOSITE: Record<Side, Side> = { below: 'above', above: 'below', right: 'left', left: 'right' };

interface Span {
  /** Lowest allowed start coordinate and highest allowed end coordinate on this axis. */
  min: number;
  max: number;
}

const clamp = (value: number, length: number, span: Span): number => Math.max(span.min, Math.min(value, span.max - length));

/** The start coordinate on the main axis (across the anchor's edge) for one side, or null when it does not fit there. */
function onSide(side: Side, anchor: Rect, length: number, gap: number, span: Span): number | null {
  const start = side === 'below' ? anchor.bottom + gap : side === 'right' ? anchor.right + gap : side === 'above' ? anchor.top - gap - length : anchor.left - gap - length;
  return start >= span.min && start + length <= span.max ? start : null;
}

/** Room on one side of the anchor, for choosing where an overlapping popup leans. */
function room(side: Side, anchor: Rect, gap: number, span: Span): number {
  if (side === 'below') return span.max - anchor.bottom - gap;
  if (side === 'above') return anchor.top - gap - span.min;
  if (side === 'right') return span.max - anchor.right - gap;
  return anchor.left - gap - span.min;
}

/** The main-axis placement: preferred side, else the opposite, else overlapping on the roomier side. */
function mainAxis(side: Side, anchor: Rect, length: number, gap: number, span: Span): { start: number; side: Side; cap?: number } {
  const limit = span.max - span.min;
  if (length > limit) return { start: span.min, side, cap: limit };
  for (const s of [side, OPPOSITE[side]]) {
    const start = onSide(s, anchor, length, gap, span);
    if (start !== null) return { start, side: s };
  }
  const lean = room(OPPOSITE[side], anchor, gap, span) > room(side, anchor, gap, span) ? OPPOSITE[side] : side;
  const near = lean === 'below' || lean === 'right' ? (lean === 'below' ? anchor.bottom : anchor.right) + gap : (lean === 'above' ? anchor.top : anchor.left) - gap - length;
  return { start: clamp(near, length, span), side: lean };
}

/**
 * The cross-axis placement: lined up with the anchor, then shifted inside. Across a horizontal
 * edge (a popup below or above) it first tries the other alignment, so it keeps one edge in line
 * with the anchor; beside the anchor (a submenu) it is only shifted, staying level with its item.
 */
function crossAxis(align: Align, from: number, to: number, length: number, span: Span, alternate: boolean): { start: number; cap?: number } {
  const limit = span.max - span.min;
  if (length > limit) return { start: span.min, cap: limit };
  const at = (a: Align) => (a === 'start' ? from : a === 'end' ? to - length : (from + to) / 2 - length / 2);
  const fits = (start: number) => start >= span.min && start + length <= span.max;
  const preferred = at(align);
  if (fits(preferred) || align === 'center' || !alternate) return { start: clamp(preferred, length, span) };
  const other = at(align === 'start' ? 'end' : 'start');
  return { start: clamp(fits(other) ? other : preferred, length, span) };
}

export function placePopup(req: PlaceRequest): Placement {
  const { anchor, size, viewport, side, align = 'start', gap = 0, margin = POPUP_MARGIN, topInset = 0 } = req;
  const xSpan: Span = { min: margin, max: viewport.width - margin };
  const ySpan: Span = { min: margin + topInset, max: viewport.height - margin };
  const vertical = side === 'below' || side === 'above';
  const main = mainAxis(side, anchor, vertical ? size.height : size.width, gap, vertical ? ySpan : xSpan);
  const cross = vertical ? crossAxis(align, anchor.left, anchor.right, size.width, xSpan, true) : crossAxis(align, anchor.top, anchor.bottom, size.height, ySpan, false);
  const [left, top] = vertical ? [cross.start, main.start] : [main.start, cross.start];
  const [maxWidth, maxHeight] = vertical ? [cross.cap, main.cap] : [main.cap, cross.cap];
  return { left: Math.round(left), top: Math.round(top), side: main.side, ...(maxHeight !== undefined && { maxHeight }), ...(maxWidth !== undefined && { maxWidth }) };
}

/** A point as an anchor (where a right-click happened). */
export const pointRect = (x: number, y: number): Rect => ({ left: x, top: y, right: x, bottom: y });
