import { describe, expect, test } from 'vitest';
import { replaceSession } from './tabs.ts';
import { canStep, currentPlace, EMPTY_HISTORY, MAX_PLACES, placeOf, step, visit, type NavHistory, type Place } from './nav-history.ts';

const page = (path: string): Place => ({ kind: 'page', path });
const session = (sessionId: string): Place => ({ kind: 'session', sessionId });
const went = (...places: Place[]): NavHistory => places.reduce(visit, EMPTY_HISTORY);

describe('back and forward', () => {
  test('a place is what a tab shows; an unsent New session screen is not one', () => {
    expect(placeOf({ id: 't', kind: 'session', sessionId: 's1' })).toEqual(session('s1'));
    expect(placeOf({ id: 't', kind: 'page', path: '#/project/x' })).toEqual(page('#/project/x'));
    expect(placeOf({ id: 't', kind: 'new', controls: { agent: 'claude', model: '', permission: 'ask', projectId: null, groupId: null } })).toBeNull();
    expect(placeOf(undefined)).toBeNull();
  });

  test('nowhere to go before the user has been anywhere else', () => {
    expect(canStep(EMPTY_HISTORY, -1)).toBe(false);
    expect(canStep(went(page('#/')), -1)).toBe(false);
    expect(canStep(went(page('#/')), 1)).toBe(false);
  });

  test('back returns to where the user was, and forward to where they came back from', () => {
    const h = went(page('#/'), session('s1'), page('#/settings'));
    const back = step(h, -1)!;
    expect(back.place).toEqual(session('s1'));
    expect(step(back.history, -1)!.place).toEqual(page('#/'));
    expect(step(back.history, 1)!.place).toEqual(page('#/settings'));
  });

  test('going to the place already in front is not a new step', () => {
    const h = went(page('#/'), session('s1'));
    expect(visit(h, session('s1'))).toBe(h);
  });

  test('going somewhere new after Back drops what was ahead, as a browser does', () => {
    const back = step(went(page('#/'), session('s1'), session('s2')), -1)!.history;
    const h = visit(back, page('#/settings'));
    expect(h.entries).toEqual([page('#/'), session('s1'), page('#/settings')]);
    expect(canStep(h, 1)).toBe(false);
    expect(currentPlace(h)).toEqual(page('#/settings'));
  });

  test('a place that is gone is stepped over, and is nowhere to go when nothing else is left', () => {
    const h = went(page('#/'), session('deleted'), session('s2'));
    const there = (place: Place) => !(place.kind === 'session' && place.sessionId === 'deleted');
    expect(step(h, -1, there)!.place).toEqual(page('#/'));
    expect(canStep(went(session('deleted'), session('s2')), -1, there)).toBe(false);
  });

  test('only the most recent places are kept', () => {
    const h = Array.from({ length: MAX_PLACES + 20 }, (_, i) => session(`s${i}`)).reduce(visit, EMPTY_HISTORY);
    expect(h.entries).toHaveLength(MAX_PLACES);
    expect(h.entries[0]).toEqual(session('s20'));
    expect(h.index).toBe(MAX_PLACES - 1);
  });
});

describe('a session that gave way to another', () => {
  const tabs = (...ids: string[]) => ({ tabs: ids.map((id) => (id.startsWith('#') ? { id: `t-${id}`, kind: 'page' as const, path: id } : { id: `t-${id}`, kind: 'session' as const, sessionId: id })), activeId: `t-${ids[0]}` });

  test('its tab shows the one that replaced it, in the same place', () => {
    const next = replaceSession(tabs('old', '#/'), 'old', 'new');
    expect(next.tabs).toEqual([{ id: 't-old', kind: 'session', sessionId: 'new' }, { id: 't-#/', kind: 'page', path: '#/' }]);
    expect(next.activeId).toBe('t-old');
  });

  test('when the new one is already open, the old tab closes and that one comes to the front', () => {
    const next = replaceSession(tabs('old', 'new'), 'old', 'new');
    expect(next.tabs).toEqual([{ id: 't-new', kind: 'session', sessionId: 'new' }]);
    expect(next.activeId).toBe('t-new');
  });

  test('nothing changes when no tab shows the old session', () => {
    const state = tabs('other', '#/');
    expect(replaceSession(state, 'old', 'new')).toBe(state);
  });
});
