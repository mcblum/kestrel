// What a head says of its session's tree and workstream, and how the copies other computers send are read and
// merged (issue 83; shared/account-workstreams.ts).
import { describe, expect, it } from 'vitest';
import type { Workstream } from '../model.ts';
import { asHeadLink, asHeadWorkstream, headLinkOf, headWorkstreamOf, remoteLinks, remoteWorkstreamRefusal, remoteWorkstreams, type HeadWorkstream } from './account-workstreams.ts';
import { asHeadRecord } from './machines.ts';

const MINI = { id: 'mini', name: 'Mac mini' };
const copy = (over: Partial<HeadWorkstream> = {}): HeadWorkstream => ({ id: 'w1', name: 'Invoice export', objective: 'Ship it', createdAt: 5, sessionIds: ['lead', 'child'], status: 'active', archivedAt: null, ...over });
const head = (id: string, workstream: HeadWorkstream | undefined, updatedAt = 1, runsOn = 'mini') => ({ id, runsOn, updatedAt, ...(workstream ? { workstream } : {}) });

describe('what a head says', () => {
  const published = new Set(['lead', 'child']);

  it('names its parent only when the parent’s head is published', () => {
    const links = [{ parentId: 'lead', childId: 'child', kind: 'delegate' as const }, { parentId: 'hidden', childId: 'lead', kind: 'fork' as const }];
    expect(headLinkOf('child', links, published)).toEqual({ parentId: 'lead', kind: 'delegate' });
    expect(headLinkOf('lead', links, published)).toBeNull();
  });

  it('carries its workstream with only the sessions whose heads are published', () => {
    const w: Workstream = { id: 'w1', name: 'Invoice export', objective: 'Ship it', createdAt: 5, sessionIds: ['lead', 'hidden', 'child'] };
    expect(headWorkstreamOf('child', [w], published)).toEqual(copy());
    expect(headWorkstreamOf('nobody', [w], published)).toBeNull();
  });
});

describe('reading what another computer sent', () => {
  it('takes a link and a workstream only in their shapes', () => {
    expect(asHeadLink({ parentId: 'p', kind: 'delegate' })).toEqual({ parentId: 'p', kind: 'delegate' });
    expect(asHeadLink({ parentId: 'p', kind: 'adopt' })).toBeNull();
    expect(asHeadWorkstream({ ...copy(), status: 'odd', archivedAt: 'x', sessionIds: ['a', 'a', 3, 'b'] })).toEqual({ ...copy(), sessionIds: ['a', 'b'], status: 'active', archivedAt: null });
    expect(asHeadWorkstream({ id: 'w', sessionIds: [] })).toBeNull();
  });

  it('a head keeps them, and an older head without them is read as before', () => {
    const session = { id: 's', title: 't', agent: 'claude', state: 'done', createdAt: 1, updatedAt: 2 };
    const read = asHeadRecord({ kind: 'head', machine: MINI, session: { ...session, link: { parentId: 'p', kind: 'handoff' }, workstream: copy() } })!;
    expect(read.head).toMatchObject({ link: { parentId: 'p', kind: 'handoff' }, workstream: copy() });
    const old = asHeadRecord({ kind: 'head', machine: MINI, session })!;
    expect(old.head).not.toHaveProperty('link');
    expect(old.head).not.toHaveProperty('workstream');
  });
});

describe('merging the copies', () => {
  const shown = new Set(['lead', 'child']);

  it('is one workstream by its id, the copy its lead’s head carries winning, marked with the computer that holds it', () => {
    const merged = remoteWorkstreams([head('child', copy({ name: 'Stale' }), 9), head('lead', copy(), 1)], [MINI], new Set(), shown);
    expect(merged.active).toEqual([{ ...copy(), heldOn: MINI }]);
    expect(remoteWorkstreamRefusal(merged.active[0]!)).toBe('“Invoice export” is on Mac mini, so it can only be changed there.');
  });

  it('without the lead’s copy, takes the copy of the head updated last', () => {
    const merged = remoteWorkstreams([head('child', copy({ name: 'Older' }), 1), head('other', copy({ name: 'Newer' }), 9)], [MINI], new Set(), shown);
    expect(merged.active.map((w) => w.name)).toEqual(['Newer']);
  });

  it('leaves out a workstream this computer holds itself, lists an active one with the sessions in sight only, and an archived one whole', () => {
    expect(remoteWorkstreams([head('lead', copy())], [MINI], new Set(['w1']), shown)).toEqual({ active: [], archived: [] });
    expect(remoteWorkstreams([head('lead', copy())], [MINI], new Set(), new Set(['lead'])).active[0]!.sessionIds).toEqual(['lead']);
    const archived = remoteWorkstreams([head('lead', copy({ archivedAt: 7 }))], [MINI], new Set(), new Set());
    expect(archived).toEqual({ active: [], archived: [{ ...copy({ archivedAt: 7 }), heldOn: MINI }] });
  });

  it('the links come from the heads of sessions this computer does not have', () => {
    expect(remoteLinks([{ id: 'child', link: { parentId: 'lead', kind: 'delegate' } }, { id: 'mine', link: { parentId: 'x', kind: 'fork' } }, { id: 'lead' }], new Set(['mine']))).toEqual([{ id: 'account|child', parentId: 'lead', childId: 'child', kind: 'delegate' }]);
  });

  it('a workstream of this computer is changed here', () => {
    expect(remoteWorkstreamRefusal({ name: 'Mine' })).toBeNull();
  });
});
