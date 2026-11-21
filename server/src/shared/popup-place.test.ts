import { describe, expect, it } from 'vitest';
import { placePopup, pointRect, type PlaceRequest, type Rect } from './popup-place.ts';

const VIEW = { width: 800, height: 600 };
const MENU = { width: 200, height: 150 };
/** A 60x20 button with its top-left corner at (x, y). */
const button = (x: number, y: number): Rect => ({ left: x, top: y, right: x + 60, bottom: y + 20 });
const place = (over: Partial<PlaceRequest> & Pick<PlaceRequest, 'anchor'>) => placePopup({ size: MENU, viewport: VIEW, side: 'below', gap: 4, margin: 8, ...over });

describe('a popup below or above its anchor', () => {
  it('opens below, lined up with the anchor’s left edge, when there is room', () => {
    expect(place({ anchor: button(100, 100) })).toEqual({ left: 100, top: 124, side: 'below' });
  });
  it('opens above when asked and there is room', () => {
    expect(place({ anchor: button(100, 400), side: 'above' })).toEqual({ left: 100, top: 246, side: 'above' });
  });
  it('flips above when there is no room below (bottom edge)', () => {
    expect(place({ anchor: button(100, 500) })).toEqual({ left: 100, top: 346, side: 'above' });
  });
  it('flips below when there is no room above (top edge)', () => {
    expect(place({ anchor: button(100, 40), side: 'above' })).toEqual({ left: 100, top: 64, side: 'below' });
  });
  it('lines up its right edge with the anchor’s when it would pass the right edge', () => {
    // The model menu: the button sits at the right end of the controls row.
    expect(place({ anchor: button(700, 500), side: 'above' })).toEqual({ left: 560, top: 346, side: 'above' });
  });
  it('lines up its left edge with the anchor’s when right-aligned would pass the left edge', () => {
    expect(place({ anchor: button(20, 100), align: 'end' })).toEqual({ left: 20, top: 124, side: 'below' });
  });
  it('is shifted inside when neither alignment fits (a wide anchor)', () => {
    const wide: Rect = { left: -50, top: 100, right: 900, bottom: 120 };
    expect(place({ anchor: wide }).left).toBe(8);
    expect(place({ anchor: wide, align: 'end' }).left).toBe(592);
  });
  it('centres on the anchor and is shifted inside at either edge', () => {
    expect(place({ anchor: button(300, 100), align: 'center' }).left).toBe(230);
    expect(place({ anchor: button(0, 100), align: 'center' }).left).toBe(8);
    expect(place({ anchor: button(760, 100), align: 'center' }).left).toBe(592);
  });
  it('overlaps the anchor, leaning to the roomier side, when neither side has room', () => {
    const short = { width: 800, height: 200 };
    const p = place({ anchor: button(100, 80), viewport: short });
    expect(p).toEqual({ left: 100, top: 42, side: 'below' });
    const nearTop = place({ anchor: button(100, 20), viewport: short, side: 'above' });
    expect(nearTop.side).toBe('below');
    expect(nearTop.top).toBe(42);
  });
  it('is capped to the window and scrolls when it is taller than the window', () => {
    expect(place({ anchor: button(100, 100), size: { width: 200, height: 900 } })).toEqual({ left: 100, top: 8, side: 'below', maxHeight: 584 });
  });
  it('is capped in width when it is wider than the window', () => {
    expect(place({ anchor: button(100, 100), size: { width: 1000, height: 100 } })).toMatchObject({ left: 8, maxWidth: 784 });
  });
  it('keeps clear of the title-bar strip at the top', () => {
    expect(place({ anchor: button(100, 160), side: 'above', topInset: 40 }).side).toBe('below');
    expect(place({ anchor: button(100, 100), size: { width: 200, height: 900 }, topInset: 40 })).toMatchObject({ top: 48, maxHeight: 544 });
  });
});

describe('a right-click menu at a point', () => {
  const at = (x: number, y: number) => place({ anchor: pointRect(x, y), gap: 0 });
  it('opens down and to the right of the point', () => expect(at(100, 100)).toEqual({ left: 100, top: 100, side: 'below' }));
  it('opens up and to the left in the bottom-right corner', () => expect(at(790, 590)).toEqual({ left: 590, top: 440, side: 'above' }));
  it('stays inside in the top-left corner', () => expect(at(0, 0)).toEqual({ left: 8, top: 8, side: 'below' }));
  it('opens to the left at the right edge', () => expect(at(780, 100).left).toBe(580));
  it('opens upward at the bottom edge', () => expect(at(100, 560).top).toBe(410));
  it('stays inside at the top-right corner', () => expect(at(799, 1)).toEqual({ left: 592, top: 8, side: 'below' }));
  it('stays inside at the bottom-left corner', () => expect(at(1, 599)).toEqual({ left: 8, top: 442, side: 'above' }));
});

describe('a submenu beside its parent item', () => {
  /** A parent menu item 190 wide at (x, y). */
  const item = (x: number, y: number): Rect => ({ left: x, top: y, right: x + 190, bottom: y + 26 });
  const sub = (over: Partial<PlaceRequest> & Pick<PlaceRequest, 'anchor'>) => place({ side: 'right', gap: 2, ...over });
  it('opens to the right, level with its item, when there is room', () => {
    expect(sub({ anchor: item(100, 100) })).toEqual({ left: 292, top: 100, side: 'right' });
  });
  it('opens to the left of the parent near the right edge', () => {
    expect(sub({ anchor: item(560, 100) })).toEqual({ left: 358, top: 100, side: 'left' });
  });
  it('opens to the right of the parent near the left edge when asked for the left', () => {
    expect(sub({ anchor: item(50, 100), side: 'left' })).toEqual({ left: 242, top: 100, side: 'right' });
  });
  it('is shifted up when it would pass the bottom', () => {
    expect(sub({ anchor: item(100, 520) })).toEqual({ left: 292, top: 442, side: 'right' });
  });
  it('in an upward menu, lines up its bottom with the item, and is shifted down when that passes the top', () => {
    expect(sub({ anchor: item(100, 300), align: 'end' }).top).toBe(176);
    expect(sub({ anchor: item(100, 60), align: 'end' }).top).toBe(8);
  });
  it('overlaps the parent when neither side has room (a narrow window)', () => {
    const narrow = { width: 400, height: 600 };
    const p = sub({ anchor: item(100, 100), viewport: narrow });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + MENU.width).toBeLessThanOrEqual(392);
  });
  it('scrolls when it is taller than the window', () => {
    expect(sub({ anchor: item(100, 100), size: { width: 200, height: 700 } })).toMatchObject({ top: 8, maxHeight: 584 });
  });
});
