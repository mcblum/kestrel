import { describe, expect, it } from 'vitest';
import { withScope, DEFAULT_CONTROLS, OVERVIEW_ID, OVERVIEW_PATH, activate, activateNth, becomeSession, closeTab, initialTabs, isLastOverview, isOnlyTab, moveTab, openTarget, placement, prune, retargetActive, sanitize, scopeOfActive, setControls, type OpenTarget, type TabsState } from './tabs.ts';

const ids = (s: TabsState) => s.tabs.map((t) => t.id);
const session = (sessionId: string): OpenTarget => ({ kind: 'session', sessionId });
const page = (path: string): OpenTarget => ({ kind: 'page', path });
const fresh = (controls = DEFAULT_CONTROLS, preselect?: { projectId?: string | null; groupId?: string | null }): OpenTarget => ({ kind: 'new', controls, ...(preselect ? { preselect } : {}) });
const PLAIN = { newTab: false };
const NEW_TAB = { newTab: true };
/** The tab-strip `+`: a New session screen in a tab of its own. */
const openNew = (s: TabsState, id: string, controls = DEFAULT_CONTROLS) => openTarget(s, fresh(controls), id, NEW_TAB);
/** Open sessions each in their own tab, as shift-click does. */
const tabsFor = (...sessions: string[]) => sessions.reduce((s, id) => openTarget(s, session(id), `t${id}`, NEW_TAB), initialTabs());

describe('where a click opens', () => {
  it('shows a plain click in the tab in front, replacing what it showed', () => {
    expect(placement(initialTabs(), session('s1'), PLAIN)).toEqual({ how: 'replace' });
    const s = openTarget(initialTabs(), session('s1'), 't1', PLAIN);
    expect(s).toEqual({ tabs: [{ id: 't1', kind: 'session', sessionId: 's1' }], activeId: 't1' });
    // Overview again: the session leaves the strip.
    const back = openTarget(s, page(OVERVIEW_PATH), 't2', PLAIN);
    expect(back).toEqual({ tabs: [{ id: 't2', kind: 'page', path: OVERVIEW_PATH }], activeId: 't2' });
  });
  it('replaces in place, keeping the tab\'s position', () => {
    const s = activate(tabsFor('a', 'b'), 'ta');
    expect(ids(openTarget(s, session('c'), 'tc', PLAIN))).toEqual([OVERVIEW_ID, 'tc', 'tb']);
  });
  it('focuses a tab that already shows the target instead of duplicating it', () => {
    const s = activate(tabsFor('a', 'b'), OVERVIEW_ID);
    expect(placement(s, session('b'), PLAIN)).toEqual({ how: 'focus', tabId: 'tb' });
    expect(openTarget(s, session('b'), 'x', PLAIN)).toEqual(activate(s, 'tb'));
    expect(placement(activate(s, 'tb'), page(OVERVIEW_PATH), PLAIN)).toEqual({ how: 'focus', tabId: OVERVIEW_ID });
  });
  it('clicking what the tab in front already shows changes nothing', () => {
    const s = tabsFor('a');
    expect(openTarget(s, session('a'), 'x', PLAIN)).toBe(s);
  });
  it('replaces an unsent New session screen like any other tab', () => {
    const s = openNew(initialTabs(), 'n1');
    expect(placement(s, session('a'), PLAIN)).toEqual({ how: 'replace' });
    expect(ids(openTarget(s, session('a'), 'ta', PLAIN))).toEqual([OVERVIEW_ID, 'ta']);
  });
  it('a new tab, when asked for, is always added and focused, even for something already open', () => {
    const s = openTarget(tabsFor('a'), session('a'), 'ta2', NEW_TAB);
    expect(ids(s)).toEqual([OVERVIEW_ID, 'ta', 'ta2']);
    expect(s.activeId).toBe('ta2');
    expect(ids(openTarget(s, page('#/project/p'), 'tp', NEW_TAB))).toEqual([OVERVIEW_ID, 'ta', 'ta2', 'tp']);
  });
  it('opens an empty new tab with the given controls and focuses it', () => {
    const s = openNew(initialTabs(), 'n1', { ...DEFAULT_CONTROLS, projectId: 'p' });
    expect(s.activeId).toBe('n1');
    expect(s.tabs[1]).toMatchObject({ kind: 'new', controls: { projectId: 'p' } });
  });
});

describe('New session', () => {
  it('is a plain navigation: Overview becomes the New session screen, in the same tab', () => {
    expect(placement(initialTabs(), fresh(), PLAIN)).toEqual({ how: 'replace' });
    const s = openTarget(initialTabs(), fresh({ ...DEFAULT_CONTROLS, model: 'haiku' }), 'n1', PLAIN);
    expect(s).toEqual({ tabs: [{ id: 'n1', kind: 'new', controls: { ...DEFAULT_CONTROLS, model: 'haiku' } }], activeId: 'n1' });
  });
  it('asked again on an unsent screen, keeps that screen as it is', () => {
    const s = openTarget(initialTabs(), fresh(), 'n1', PLAIN);
    expect(placement(s, fresh(), PLAIN)).toEqual({ how: 'focus', tabId: 'n1' });
    expect(openTarget(s, fresh({ ...DEFAULT_CONTROLS, model: 'other' }), 'n2', PLAIN)).toBe(s);
  });
  it('applies a preselected project or folder to the unsent screen instead of making another', () => {
    const s = openTarget(initialTabs(), fresh({ ...DEFAULT_CONTROLS, model: 'haiku' }), 'n1', PLAIN);
    const next = openTarget(s, fresh(DEFAULT_CONTROLS, { projectId: 'wren' }), 'n2', PLAIN);
    expect(ids(next)).toEqual(['n1']);
    expect(next.tabs[0]).toMatchObject({ kind: 'new', controls: { model: 'haiku', projectId: 'wren', groupId: null } });
    expect(openTarget(next, fresh(DEFAULT_CONTROLS, { projectId: 'wren' }), 'n3', PLAIN)).toBe(next);
  });
  it('focuses an unsent screen in another tab rather than making a second one', () => {
    const s = activate(openNew(tabsFor('a'), 'n1'), 'ta');
    expect(placement(s, fresh(), PLAIN)).toEqual({ how: 'focus', tabId: 'n1' });
    const next = openTarget(s, fresh(DEFAULT_CONTROLS, { groupId: 'g1' }), 'n2', PLAIN);
    expect(ids(next)).toEqual([OVERVIEW_ID, 'ta', 'n1']);
    expect(next.activeId).toBe('n1');
    expect(next.tabs[2]).toMatchObject({ controls: { groupId: 'g1' } });
  });
  it('drops the directory chosen for one project when another project is preselected, and keeps it for the same project', () => {
    const shop = { ...DEFAULT_CONTROLS, projectId: 'shop', folderId: 'shop-web' };
    const s = openTarget(initialTabs(), fresh(shop), 'n1', PLAIN);
    expect(openTarget(s, fresh(DEFAULT_CONTROLS, { projectId: 'shop' }), 'n2', PLAIN)).toBe(s);
    const other = openTarget(s, fresh(DEFAULT_CONTROLS, { projectId: 'wren' }), 'n2', PLAIN);
    expect(other.tabs[0]).toMatchObject({ kind: 'new', controls: { projectId: 'wren' } });
    expect((other.tabs[0] as { controls: object }).controls).not.toHaveProperty('folderId');
    expect(withScope(shop, { groupId: 'g1' })).toMatchObject({ projectId: 'shop', folderId: 'shop-web', groupId: 'g1' });
    expect(withScope(shop, { projectId: 'wren', folderId: 'w2' })).toMatchObject({ projectId: 'wren', folderId: 'w2' });
  });
  it('a box on another computer goes back to this one when another project is named without a computer (issue 52)', () => {
    const there = { ...DEFAULT_CONTROLS, projectId: 'billing', machine: 'mini' };
    expect(withScope(there, { projectId: 'shop' })).not.toHaveProperty('machine');
    expect(withScope(there, { projectId: 'notes', machine: 'studio' })).toMatchObject({ projectId: 'notes', machine: 'studio' });
    expect(withScope(there, { groupId: 'g1' })).toMatchObject({ machine: 'mini' });
  });
  it('repeated New session never piles up tabs', () => {
    let s = initialTabs();
    for (let i = 0; i < 50; i++) s = openTarget(s, fresh(), `n${i}`, PLAIN);
    expect(ids(s)).toEqual(['n0']);
  });
  it('opens in a new tab only when asked, with the preselection applied', () => {
    const s = openTarget(initialTabs(), fresh(DEFAULT_CONTROLS, { projectId: 'p' }), 'n1', NEW_TAB);
    expect(ids(s)).toEqual([OVERVIEW_ID, 'n1']);
    expect(s.tabs[1]).toMatchObject({ kind: 'new', controls: { projectId: 'p' } });
    expect(ids(openTarget(s, fresh(), 'n2', NEW_TAB))).toEqual([OVERVIEW_ID, 'n1', 'n2']);
  });
});

describe('a new tab becoming a session', () => {
  it('keeps its id and position', () => {
    let s = openNew(tabsFor('s1'), 'n1', DEFAULT_CONTROLS);
    s = openTarget(s, session('s2'), 't2', NEW_TAB);
    s = becomeSession(s, 'n1', 'sNew');
    expect(s.tabs.map((t) => [t.id, t.kind])).toEqual([[OVERVIEW_ID, 'page'], ['ts1', 'session'], ['n1', 'session'], ['t2', 'session']]);
    expect((s.tabs[2] as any).sessionId).toBe('sNew');
  });
  it('changes controls only on new tabs', () => {
    const s = openNew(initialTabs(), 'n1', DEFAULT_CONTROLS);
    expect((setControls(s, 'n1', { ...DEFAULT_CONTROLS, model: 'haiku' }).tabs[1] as any).controls.model).toBe('haiku');
    expect(setControls(s, OVERVIEW_ID, DEFAULT_CONTROLS)).toEqual(s);
  });
});

describe('closing', () => {
  const three = () => tabsFor('a', 'b', 'c');
  it('moves focus to the left neighbour when the active tab closes', () => {
    const s = activate(three(), 'tb');
    const closed = closeTab(s, 'tb');
    expect(ids(closed)).toEqual([OVERVIEW_ID, 'ta', 'tc']);
    expect(closed.activeId).toBe('ta');
  });
  it('keeps the active tab when another closes; Overview closes like any tab', () => {
    expect(closeTab(three(), 'ta').activeId).toBe('tc');
    const s = closeTab(three(), OVERVIEW_ID);
    expect(ids(s)).toEqual(['ta', 'tb', 'tc']);
    expect(closeTab(activate(three(), OVERVIEW_ID), OVERVIEW_ID).activeId).toBe('ta');
  });
  it('closing the last tab leaves Overview, which then stays', () => {
    const only = openTarget(initialTabs(), session('a'), 'ta', PLAIN);
    expect(isOnlyTab(only)).toBe(true);
    expect(isLastOverview(only)).toBe(false);
    expect(closeTab(only, 'ta')).toEqual(initialTabs());
    expect(isOnlyTab(three())).toBe(false);
    expect(closeTab(initialTabs(), OVERVIEW_ID)).toEqual(initialTabs());
  });
});

describe('switching and moving', () => {
  const s = () => tabsFor('a', 'b');
  it('activates the nth tab, 1-based, ignoring out of range', () => {
    expect(activateNth(s(), 2).activeId).toBe('ta');
    expect(activateNth(s(), 1).activeId).toBe(OVERVIEW_ID);
    expect(activateNth(s(), 9)).toEqual(s());
  });
  it('reorders any tab, clamped to the strip', () => {
    expect(ids(moveTab(s(), 'tb', 1))).toEqual([OVERVIEW_ID, 'tb', 'ta']);
    expect(ids(moveTab(s(), 'tb', 0))).toEqual(['tb', OVERVIEW_ID, 'ta']);
    expect(ids(moveTab(s(), OVERVIEW_ID, 2))).toEqual(['ta', 'tb', OVERVIEW_ID]);
    expect(ids(moveTab(s(), 'ta', 99))).toEqual([OVERVIEW_ID, 'tb', 'ta']);
  });
});

describe('stored state', () => {
  it('drops tabs for sessions that are gone, leaving Overview when nothing is left', () => {
    const s = prune(tabsFor('a', 'b'), new Set(['b']));
    expect(ids(s)).toEqual([OVERVIEW_ID, 'tb']);
    expect(s.activeId).toBe('tb');
    expect(prune(activate(tabsFor('a', 'b'), 'ta'), new Set(['b'])).activeId).toBe(OVERVIEW_ID);
    expect(prune(openTarget(initialTabs(), session('a'), 'ta', PLAIN), new Set())).toEqual(initialTabs());
    // A session just created here, not in the pushed list yet, keeps its tab and stays in front.
    const fresh = activate(tabsFor('a', 'b'), 'tb');
    expect(prune(fresh, new Set(['a']), new Set(['b']))).toBe(fresh);
    expect(prune(fresh, new Set(['a'])).activeId).not.toBe('tb');
  });
  it('sanitizes anything malformed and removes duplicates', () => {
    expect(sanitize(null)).toEqual(initialTabs());
    expect(sanitize({ tabs: 'x' })).toEqual(initialTabs());
    expect(sanitize({ tabs: [] })).toEqual(initialTabs());
    const s = sanitize({ tabs: [{ id: 't1', kind: 'session', sessionId: 's' }, { id: 'p', kind: 'page', path: '#/project/x' }, { id: 't1', kind: 'session', sessionId: 'dup' }, { id: 'bad', kind: 'nope' }, { id: 'q', kind: 'page', path: 'javascript:x' }, { id: 'n', kind: 'new', controls: { model: 'haiku' } }], activeId: 'gone' });
    expect(ids(s)).toEqual(['t1', 'p', 'n']);
    expect(s.activeId).toBe('t1');
    expect((s.tabs[2] as any).controls).toMatchObject({ agent: 'claude', model: 'haiku', permission: 'ask' });
  });
  it('loads state saved before this change: the pinned Overview and many tabs', () => {
    const old = { tabs: [{ id: OVERVIEW_ID, kind: 'overview' }, ...['a', 'b', 'c'].map((x) => ({ id: `t${x}`, kind: 'session', sessionId: x }))], activeId: 'tb' };
    const s = sanitize(old);
    expect(s.tabs[0]).toEqual({ id: OVERVIEW_ID, kind: 'page', path: OVERVIEW_PATH });
    expect(ids(s)).toEqual([OVERVIEW_ID, 'ta', 'tb', 'tc']);
    expect(s.activeId).toBe('tb');
  });
});

describe('the scope a plain New session inherits', () => {
  const sessions = [
    { id: 's1', startedIn: 'infra', landedIn: 'ci', groupId: 'g1' },
    { id: 's2', startedIn: 'wren', landedIn: null, groupId: null },
  ];
  it('is the page shown when a page tab is in front', () => {
    expect(scopeOfActive(initialTabs(), { projectId: 'wren' }, sessions)).toEqual({ projectId: 'wren' });
    expect(scopeOfActive(initialTabs(), {}, sessions)).toEqual({});
  });
  it('is the session\'s project and folder on a session tab, preferring where the work landed', () => {
    expect(scopeOfActive(openTarget(initialTabs(), session('s1'), 't1', PLAIN), { projectId: 'wren' }, sessions)).toEqual({ projectId: 'ci', groupId: 'g1' });
    expect(scopeOfActive(openTarget(initialTabs(), session('s2'), 't2', PLAIN), {}, sessions)).toEqual({ projectId: 'wren' });
  });
  it('is the unsent tab\'s own choices on a new tab', () => {
    const s = openNew(initialTabs(), 'n1', { ...DEFAULT_CONTROLS, projectId: 'shrike' });
    expect(scopeOfActive(s, { projectId: 'wren' }, sessions)).toEqual({ projectId: 'shrike' });
  });
  it('is empty for a session that no longer exists', () => {
    expect(scopeOfActive(openTarget(initialTabs(), session('gone'), 't1', PLAIN), { projectId: 'wren' }, sessions)).toEqual({});
  });
});

describe('a local tab inside the page in front', () => {
  it('changes the path of the tab in front without a new tab or a new id', () => {
    const s: TabsState = { tabs: [{ id: 'a', kind: 'page', path: '#/project/p' }, { id: 'b', kind: 'page', path: '#/' }], activeId: 'a' };
    const next = retargetActive(s, '#/project/p/settings');
    expect(next.tabs).toEqual([{ id: 'a', kind: 'page', path: '#/project/p/settings' }, { id: 'b', kind: 'page', path: '#/' }]);
    expect(next.activeId).toBe('a');
    expect(retargetActive(next, '#/project/p/settings')).toBe(next);
  });

  it('leaves a session tab alone', () => {
    const s: TabsState = { tabs: [{ id: 's', kind: 'session', sessionId: 'x' }], activeId: 's' };
    expect(retargetActive(s, '#/project/p')).toBe(s);
  });
});
