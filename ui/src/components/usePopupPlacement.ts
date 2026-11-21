// Keeps a popup inside the window: measures it after render and places it before paint with the
// one placement rule (shared/popup-place.ts), then again when the window is resized, when the
// popup's own size changes (ResizeObserver) and when something scrolls under its anchor. Every
// menu, picker, card and tooltip goes through here. The popup is `position: fixed`, so a
// scrolling list or pane around its anchor cannot clip it.
import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react';
import { placePopup, type Align, type Placement, type Rect, type Side } from '@kestrel/server/popup-place';

export interface PopupWhere {
  /** What the popup hangs from, in window coordinates, read when it is placed. */
  anchor: Rect;
  side: Side;
  align?: Align;
  /** Space between the anchor and the popup. */
  gap?: number;
  /** Space kept free at the window's edges, when not the usual. */
  margin?: number;
}

/** The desktop app's draggable title-bar strip (the tab strip, with the window buttons in it). */
const TITLE_BAR_STRIP = 40;

/** Space a popup keeps from the top of the window beyond the usual margin: the title-bar strip on a Mac, outside full screen. */
const topInset = (): number => (document.querySelector('.kestrel.mac-chrome:not(.full-screen)') ? TITLE_BAR_STRIP : 0);

const px = (n: number) => `${n}px`;

/** Vertical padding and border, which a `max-height` on a content-box element does not include. */
function verticalChrome(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  if (cs.boxSizing === 'border-box') return 0;
  return ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, k) => sum + (parseFloat(cs[k as 'paddingTop']) || 0), 0);
}

/** Measures `el` at its natural size and moves it to where the rule says. Returns the placement. */
export function applyPlacement(el: HTMLElement, where: PopupWhere): Placement {
  const s = el.style;
  // Measure uncapped, from the containing block's corner, so the size is the popup's own.
  Object.assign(s, { left: '0px', top: '0px', right: 'auto', bottom: 'auto', maxHeight: '', maxWidth: '', overflowY: '' });
  const natural = el.getBoundingClientRect();
  const p = placePopup({ ...where, size: { width: natural.width, height: natural.height }, viewport: { width: window.innerWidth, height: window.innerHeight }, topInset: topInset() });
  // `natural.left/top` is where (0, 0) lands: not the window's corner when an ancestor is transformed.
  s.left = px(p.left - natural.left);
  s.top = px(p.top - natural.top);
  if (p.maxHeight !== undefined) Object.assign(s, { maxHeight: px(p.maxHeight - verticalChrome(el)), overflowY: 'auto' });
  if (p.maxWidth !== undefined) s.maxWidth = px(p.maxWidth);
  return p;
}

/**
 * Places the popup in `ref` while it is rendered. `where` is read each time it is placed (so it
 * can measure its anchor then) and returns null to leave the popup alone. Returns the latest
 * placement, for a popup whose children lean the same way (a submenu of a flipped submenu).
 */
export function usePopupPlacement(ref: RefObject<HTMLElement | null>, where: () => PopupWhere | null, deps: DependencyList): RefObject<Placement | null> {
  const latest = useRef(where);
  latest.current = where;
  const placed = useRef<Placement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const w = latest.current();
      if (w && el.isConnected) placed.current = applyPlacement(el, w);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    // A scroll under the anchor moves it; a scroll inside the popup does not.
    const onScroll = (e: Event) => !(e.target instanceof Node && el.contains(e.target)) && place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `where` is read through `latest`.
  }, deps);
  return placed;
}

/** The composer's controls row sits at the bottom of the window, so what opens from it opens upward. */
export const opensUpward = (anchor: Element): boolean => anchor.closest('.composer-under') !== null;

/** An element's box as a placement anchor. */
export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
