import { describe, expect, it } from 'vitest';
import { isPermutation, isPinKind, isPinned, parsePinOrder, placePin, storedPinOrder, visiblePins } from './pins.ts';

const ref = (kind: 'session' | 'project' | 'group', id: string) => ({ kind, id });

describe('pins', () => {
  const pins = [
    { kind: 'group' as const, id: 'g1', pinnedAt: 3 },
    { kind: 'session' as const, id: 's1', pinnedAt: 1 },
    { kind: 'project' as const, id: 'p1', pinnedAt: 2 },
    { kind: 'session' as const, id: 'gone', pinnedAt: 4 },
  ];
  it('keeps the pins whose item is in sight, in the stored order (not the order they were pinned)', () => {
    const shown = { sessions: new Set(['s1']), projects: new Set(['p1']), groups: new Set(['g1']) };
    expect(visiblePins(pins, shown).map((p) => p.id)).toEqual(['g1', 's1', 'p1']);
    expect(visiblePins(pins, { sessions: new Set(), projects: new Set(['g1']), groups: new Set() })).toEqual([]);
  });
  it('tells kinds and pinned items apart', () => {
    expect(isPinned(pins, 'session', 's1')).toBe(true);
    expect(isPinned(pins, 'project', 's1')).toBe(false);
    expect(isPinKind('group')).toBe(true);
    expect(isPinKind('folder')).toBe(false);
  });
});

describe('an order sent by the client', () => {
  it('is a list of kinds and ids, each once', () => {
    expect(parsePinOrder([ref('session', 's1'), ref('group', 's1')])).toEqual([ref('session', 's1'), ref('group', 's1')]);
    expect(parsePinOrder([])).toEqual([]);
  });
  it('is refused when it is not a list, has a bad entry, or lists a pin twice', () => {
    expect(parsePinOrder('s1')).toHaveProperty('reason');
    expect(parsePinOrder([{ kind: 'folder', id: 'g1' }])).toHaveProperty('reason');
    expect(parsePinOrder([{ kind: 'session', id: '' }])).toHaveProperty('reason');
    expect(parsePinOrder([{ kind: 'session', id: 'x'.repeat(301) }])).toHaveProperty('reason');
    expect(parsePinOrder([null])).toHaveProperty('reason');
    expect(parsePinOrder([ref('session', 's1'), ref('session', 's1')])).toHaveProperty('reason');
  });
  it('must be exactly the current pins, in any order', () => {
    const current = [ref('session', 's1'), ref('project', 'p1'), ref('group', 'g1')];
    expect(isPermutation(current, [ref('group', 'g1'), ref('session', 's1'), ref('project', 'p1')])).toBe(true);
    expect(isPermutation(current, [ref('group', 'g1'), ref('session', 's1')])).toBe(false);
    expect(isPermutation(current, [ref('group', 'g1'), ref('session', 's1'), ref('project', 'p2')])).toBe(false);
    expect(isPermutation(current, [ref('group', 'g1'), ref('session', 's1'), ref('session', 's1')])).toBe(false);
    expect(isPermutation(current, [ref('group', 'g1'), ref('session', 's1'), ref('project', 'p1'), ref('session', 's2')])).toBe(false);
  });
});

describe('the stored order after a reorder', () => {
  it('moves the pins in sight into their new order and leaves the ones out of sight in their places', () => {
    const stored = [ref('session', 'a'), ref('session', 'hidden'), ref('group', 'b'), ref('project', 'c')];
    const visible = [ref('project', 'c'), ref('session', 'a'), ref('group', 'b')];
    expect(storedPinOrder(stored, visible)).toEqual([ref('project', 'c'), ref('session', 'hidden'), ref('session', 'a'), ref('group', 'b')]);
  });
});

describe('dropping a pin', () => {
  const list = [ref('session', 'a'), ref('group', 'b'), ref('project', 'c')];
  it('lands before or after the row it was dropped on', () => {
    expect(placePin(list, ref('project', 'c'), ref('session', 'a'), false)).toEqual([ref('project', 'c'), ref('session', 'a'), ref('group', 'b')]);
    expect(placePin(list, ref('session', 'a'), ref('group', 'b'), true)).toEqual([ref('group', 'b'), ref('session', 'a'), ref('project', 'c')]);
  });
  it('goes to the end with no target, and an item not pinned yet joins the list where it is dropped', () => {
    expect(placePin(list, ref('session', 'a'), null, false)).toEqual([ref('group', 'b'), ref('project', 'c'), ref('session', 'a')]);
    expect(placePin(list, ref('session', 'new'), ref('group', 'b'), false)).toEqual([ref('session', 'a'), ref('session', 'new'), ref('group', 'b'), ref('project', 'c')]);
  });
});
