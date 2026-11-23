import { describe, expect, it } from 'vitest';
import { EMPTY_SIDEBAR, MENU_ITEMS, PANE_WIDTH, SIDEBAR_WIDTH, arrange, clampPaneWidth, clampWidth, menuOrder, place, placeMenuItem, placeProject, placeTag, placeWorkstream, sanitizeSidebar, toggleCollapsed, toggleHidden } from './sidebar.ts';

const id = (x: string) => x;

describe('arranging the sidebar', () => {
  it('keeps the given order when nothing has been dragged', () => {
    expect(arrange(['a', 'b', 'c'], id, [])).toEqual(['a', 'b', 'c']);
  });
  it('follows the saved order and puts new items first', () => {
    expect(arrange(['a', 'b', 'c', 'new'], id, ['c', 'a', 'b', 'gone'])).toEqual(['new', 'c', 'a', 'b']);
  });
});

describe('dropping an item', () => {
  const present = ['a', 'b', 'c', 'd'];
  it('goes before the row it was dropped on', () => {
    expect(place([], present, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('goes after it when dropped on the lower half', () => {
    expect(place([], present, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('goes to the end with no target, or when the target is unknown', () => {
    expect(place([], present, 'a', null)).toEqual(['b', 'c', 'd', 'a']);
    expect(place([], present, 'a', 'zzz')).toEqual(['b', 'c', 'd', 'a']);
  });
  it('builds on an earlier order and drops ids that are no longer shown', () => {
    expect(place(['d', 'gone', 'c', 'b', 'a'], present, 'a', 'd')).toEqual(['a', 'd', 'c', 'b']);
  });
  it('dropping a row on itself changes nothing about the others', () => {
    expect(place(['a', 'b', 'c', 'd'], present, 'b', 'b').filter((x) => x !== 'b')).toEqual(['a', 'c', 'd']);
  });
});

describe('reordering groups and projects', () => {
  it('a group moves among the top-level items, before or after a session or another group', () => {
    // Groups g1, g2 and top-level sessions s1, s2 share one order.
    const present = ['g1', 's1', 'g2', 's2'];
    expect(place(['g1', 's1', 'g2', 's2'], present, 'g2', 'g1')).toEqual(['g2', 'g1', 's1', 's2']);
    expect(place(['g1', 's1', 'g2', 's2'], present, 'g1', 's2', true)).toEqual(['s1', 'g2', 's2', 'g1']);
  });
  it('places a project before or after another and keeps the session order untouched', () => {
    const prefs = { ...EMPTY_SIDEBAR, order: ['s1', 'g1'] };
    const present = ['pA', 'pB', 'pC'];
    expect(placeProject(prefs, present, 'pC', 'pA')).toEqual({ ...prefs, projectOrder: ['pC', 'pA', 'pB'] });
    expect(placeProject(prefs, present, 'pA', 'pB', true).projectOrder).toEqual(['pB', 'pA', 'pC']);
  });
  it('builds on an earlier project order; a project it does not know yet comes first', () => {
    const prefs = { ...EMPTY_SIDEBAR, projectOrder: ['pB', 'pA'] };
    expect(placeProject(prefs, ['pA', 'pB', 'pNew'], 'pA', 'pB').projectOrder).toEqual(['pNew', 'pA', 'pB']);
    expect(arrange(['pA', 'pB', 'pNew'], id, ['pB', 'pA'])).toEqual(['pNew', 'pB', 'pA']);
  });
});

describe('collapsing and stored values', () => {
  it('toggles a key', () => {
    const once = toggleCollapsed(EMPTY_SIDEBAR, 'projects');
    expect(once.collapsed).toEqual(['projects']);
    expect(toggleCollapsed(once, 'projects').collapsed).toEqual([]);
  });
  it('holds a dragged width inside its limits and ignores a stored value that is not a number', () => {
    expect(clampWidth(50)).toBe(SIDEBAR_WIDTH.min);
    expect(clampWidth(9000)).toBe(SIDEBAR_WIDTH.max);
    expect(clampWidth(301.6)).toBe(302);
    expect(sanitizeSidebar({ width: 9000 }).width).toBe(SIDEBAR_WIDTH.max);
    expect(sanitizeSidebar({ width: 'wide' }).width).toBeUndefined();
    expect(clampPaneWidth(10)).toBe(PANE_WIDTH.min);
    expect(sanitizeSidebar({ paneWidth: 99999 }).paneWidth).toBe(PANE_WIDTH.max);
  });
  it('keeps only strings from stored data', () => {
    expect(sanitizeSidebar({ order: ['a', 3, 'a', ''], collapsed: 'x' })).toEqual({ order: ['a'], collapsed: [] });
    expect(sanitizeSidebar(null)).toEqual(EMPTY_SIDEBAR);
  });
  it('keeps a stored project order as clean strings', () => {
    expect(sanitizeSidebar({ order: [], collapsed: [], projectOrder: ['pA', 7, 'pA', '', 'pB'] }).projectOrder).toEqual(['pA', 'pB']);
    expect(sanitizeSidebar({ projectOrder: 'pA' }).projectOrder).toBeUndefined();
  });
  it('loads prefs stored before projects had an order', () => {
    const old = sanitizeSidebar({ order: ['g1', 's1'], collapsed: ['projects'], width: 300 });
    expect(old).toEqual({ order: ['g1', 's1'], collapsed: ['projects'], width: 300 });
    expect(placeProject(old, ['pA', 'pB'], 'pB', 'pA').projectOrder).toEqual(['pB', 'pA']);
  });
});

describe('hiding the sidebar', () => {
  it('toggles, keeping everything else, and is stored only while hidden', () => {
    const shown = { ...EMPTY_SIDEBAR, width: 300, collapsed: ['tags'] };
    const hidden = toggleHidden(shown);
    expect(hidden).toEqual({ ...shown, hidden: true });
    expect(toggleHidden(hidden)).toEqual(shown);
    expect('hidden' in toggleHidden(hidden)).toBe(false);
  });

  it('survives a reload; anything but true reads as shown', () => {
    expect(sanitizeSidebar({ hidden: true }).hidden).toBe(true);
    expect(sanitizeSidebar({ hidden: 'yes' }).hidden).toBeUndefined();
    expect(sanitizeSidebar({}).hidden).toBeUndefined();
  });
});

describe('the tag order', () => {
  it('takes a dragged tag beside another and keeps only clean ids when read back', () => {
    const prefs = { ...EMPTY_SIDEBAR, tagOrder: ['infra', 'plat-1'] };
    expect(placeTag(prefs, ['infra', 'plat-1', 'release'], 'release', 'infra').tagOrder).toEqual(['release', 'infra', 'plat-1']);
    expect(sanitizeSidebar({ order: [], collapsed: [], tagOrder: ['a', 3, 'a', 'b'] }).tagOrder).toEqual(['a', 'b']);
    expect(sanitizeSidebar({ order: [], collapsed: [] }).tagOrder).toBeUndefined();
  });
});

describe('the session order choice', () => {
  it('survives a reload and is dropped when unknown, keeping the dragged order beside it', () => {
    expect(sanitizeSidebar({ order: ['s2', 's1'], collapsed: [], sessionOrder: 'custom' })).toEqual({ order: ['s2', 's1'], collapsed: [], sessionOrder: 'custom' });
    expect(sanitizeSidebar({ sessionOrder: 'recent' }).sessionOrder).toBe('recent');
    expect(sanitizeSidebar({ sessionOrder: 'alphabetical' }).sessionOrder).toBeUndefined();
  });
});

describe('the order of workstreams', () => {
  it('is kept by id, survives a round trip, and puts a new workstream first', () => {
    const placed = placeWorkstream(EMPTY_SIDEBAR, ['a', 'b', 'c'], 'c', 'a');
    expect(placed.workstreamOrder).toEqual(['c', 'a', 'b']);
    expect(sanitizeSidebar(JSON.parse(JSON.stringify(placed))).workstreamOrder).toEqual(['c', 'a', 'b']);
    expect(sanitizeSidebar({}).workstreamOrder).toBeUndefined();
    expect(arrange(['new', 'a', 'b', 'c'], (id) => id, placed.workstreamOrder!)).toEqual(['new', 'c', 'a', 'b']);
  });
});

describe('the top menu order', () => {
  it('is the shipped order until a row is dragged', () => {
    expect(menuOrder(EMPTY_SIDEBAR)).toEqual([...MENU_ITEMS]);
  });

  it('puts a dragged row before or after the row it is dropped on', () => {
    const moved = placeMenuItem(EMPTY_SIDEBAR, 'pull-requests', 'overview');
    expect(menuOrder(moved)).toEqual(['pull-requests', 'overview', 'new-session', 'code-reviews', 'tickets']);
    expect(menuOrder(placeMenuItem(moved, 'overview', 'tickets', true))).toEqual(['pull-requests', 'new-session', 'code-reviews', 'tickets', 'overview']);
  });

  it('keeps a row the saved order does not know after the ones it does', () => {
    expect(menuOrder({ ...EMPTY_SIDEBAR, menuOrder: ['new-session', 'overview'] })).toEqual(['new-session', 'overview', 'pull-requests', 'code-reviews', 'tickets']);
  });

  it('ignores anything that is not a menu row', () => {
    expect(placeMenuItem(EMPTY_SIDEBAR, 'nope', 'overview')).toBe(EMPTY_SIDEBAR);
    expect(sanitizeSidebar({ order: [], collapsed: [], menuOrder: ['tickets', 'nope', 3, 'overview'] }).menuOrder).toEqual(['tickets', 'overview']);
  });
});
