import { describe, expect, it } from 'vitest';
import type { Link, SessionWait } from '../model.ts';
import { checkWait, visibleWaits, waitCycle, waitsIn, WAIT_REASON_MAX } from './waits.ts';

const wait = (waiterId: string, targetId: string, reason = 'r'): SessionWait => ({ workstreamId: 'w', waiterId, targetId, reason, createdAt: 1 });
const workstream = { id: 'w', name: 'Invoices', sessionIds: ['lead', 'a', 'b', 'c'] };
const sessions = [
  { id: 'lead', title: 'Plan invoices', state: 'done' as const },
  { id: 'a', title: 'App A', state: 'running' as const },
  { id: 'b', title: 'App B endpoint', state: 'running' as const },
  { id: 'c', title: 'App C', state: 'attention' as const },
  { id: 'out', title: 'Elsewhere', state: 'running' as const },
];
const check = (waiterId: string, targetId: string, reason = 'the export endpoint', waits: SessionWait[] = []) => checkWait({ waiterId, targetId, reason, workstreams: [workstream], sessions, waits });

describe('declaring a wait (wait_for)', () => {
  it('accepts a wait on another open session in the same workstream', () => {
    expect(check('a', 'b')).toEqual({ ok: true, workstreamId: 'w', reason: 'the export endpoint' });
    // Waiting on the user is not finished: it can be waited on.
    expect(check('a', 'c')).toMatchObject({ ok: true });
  });
  it('refuses a session in no workstream', () => {
    expect(check('out', 'a')).toEqual({ ok: false, reason: expect.stringMatching(/not in a workstream/) });
  });
  it('refuses a target outside the workstream, naming the sessions that are in it with their ids', () => {
    const refused = check('a', 'out');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('not in “Invoices”');
    for (const s of ['“Plan invoices” (lead)', '“App B endpoint” (b)', '“App C” (c)']) expect(refused.reason).toContain(s);
    expect(refused.reason).not.toContain('(a)');
    expect(check('a', 'nope')).toMatchObject({ ok: false });
  });
  it('refuses waiting on itself', () => {
    expect(check('a', 'a')).toEqual({ ok: false, reason: expect.stringMatching(/yourself/) });
  });
  it('refuses a target that has already finished, marked so the caller can be given its report', () => {
    expect(check('a', 'lead')).toEqual({ ok: false, finished: true, reason: expect.stringMatching(/already finished/) });
  });
  it('refuses a wait that would close a cycle, naming the chain', () => {
    const refused = check('a', 'b', 'x', [wait('b', 'c'), wait('c', 'a')]);
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining('“App B endpoint” → “App C” → “App A”') });
    expect(check('a', 'b', 'x', [wait('b', 'a')])).toMatchObject({ ok: false });
  });
  it('refuses an empty or over-long reason', () => {
    expect(check('a', 'b', '   ')).toMatchObject({ ok: false, reason: expect.stringMatching(/what you are waiting for/) });
    expect(check('a', 'b', 'x'.repeat(WAIT_REASON_MAX + 1))).toMatchObject({ ok: false, reason: expect.stringContaining(String(WAIT_REASON_MAX)) });
    expect(check('a', 'b', `  ${'x'.repeat(WAIT_REASON_MAX)}  `)).toMatchObject({ ok: true });
  });
  it('replacing a wait on the same target is not a cycle', () => {
    expect(check('a', 'b', 'new reason', [wait('a', 'b', 'old')])).toMatchObject({ ok: true, reason: 'new reason' });
  });
});

describe('cycles', () => {
  it('finds the chain from the target back to the waiter, or none', () => {
    expect(waitCycle([wait('b', 'c'), wait('c', 'a')], 'a', 'b')).toEqual(['a', 'b', 'c', 'a']);
    expect(waitCycle([wait('b', 'c')], 'a', 'b')).toBeNull();
    expect(waitCycle([wait('b', 'c'), wait('c', 'b')], 'a', 'b')).toBeNull();
  });
});

describe('the waits a workstream shows', () => {
  const links: Link[] = [{ id: 'l1', parentId: 'lead', childId: 'a', kind: 'delegate' }];
  const members = [
    { id: 'lead', title: 'Plan invoices', state: 'done' as const },
    { id: 'a', title: 'App A', state: 'running' as const },
    { id: 'b', title: 'App B endpoint', state: 'running' as const },
  ];
  it('puts an orchestrator waiting on its delegates and the declared waits in one list', () => {
    expect(waitsIn({ id: 'w', sessionIds: ['lead', 'a', 'b'] }, members, links, [wait('a', 'b', 'the export endpoint'), { ...wait('x', 'y'), workstreamId: 'other' }])).toEqual([
      { kind: 'started', waiterId: 'lead', count: 1 },
      { kind: 'declared', waiterId: 'a', targetId: 'b', reason: 'the export endpoint' },
    ]);
  });
  it('shows nothing when nobody waits', () => {
    expect(waitsIn({ id: 'w', sessionIds: ['b'] }, members, [], [])).toEqual([]);
  });
  it('keeps for the state only the waits between sessions in sight, inside one workstream', () => {
    const all = [wait('a', 'b'), wait('a', 'hidden'), { ...wait('a', 'b'), workstreamId: 'gone' }];
    expect(visibleWaits(all, [{ id: 'w', sessionIds: ['a', 'b'] }])).toEqual([wait('a', 'b')]);
  });
});
