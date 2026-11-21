import { describe, expect, it } from 'vitest';
import { afterUserMessage, archiveRefusal, completeRefusal, isOpenWork, leadOf, childGroupId, delegatedText, isArchived, isComplete, shownWorkstreams, splitArchived, workstreamRows, workstreamShape, delegateWorkstream, visibleWorkstreams, waitingOn, workstreamName, workstreamNotice, workstreamObjective, workstreamOf, workstreamSummary, WORKSTREAM_NAME_MAX } from './workstreams.ts';

const s = (startedIn: string | null, landedIn: string | null = null) => ({ startedIn, landedIn });
const w = (id: string, sessionIds: string[]) => ({ id, name: id, objective: '', createdAt: 1, sessionIds });

describe('what a delegate does about workstreams', () => {
  it('needs none when the split stays in the orchestrator’s own project', () => {
    expect(delegateWorkstream(s('p1'), ['p1', 'p1'], null)).toBe('none');
    expect(delegateWorkstream(s('p2', 'p1'), ['p1'], null)).toBe('none');
  });

  it('starts one when the split reaches another project, or the orchestrator has no project', () => {
    expect(delegateWorkstream(s('p1'), ['p1', 'p2'], null)).toBe('create');
    expect(delegateWorkstream(s('p1'), ['p2'], null)).toBe('create');
    expect(delegateWorkstream(s(null), ['p1'], null)).toBe('create');
  });

  it('adds to the workstream the orchestrator is already in, even for work in its own project', () => {
    expect(delegateWorkstream(s('p1'), ['p1'], { id: 'w' })).toEqual({ join: 'w' });
    expect(delegateWorkstream(s('p1'), ['p2'], { id: 'w' })).toEqual({ join: 'w' });
  });
});

describe('the group a started session begins in', () => {
  it('is its parent’s when that group can hold it', () => {
    expect(childGroupId({ id: 'g', projectId: null }, 'p2')).toBe('g');
    expect(childGroupId({ id: 'g', projectId: 'p1' }, 'p1')).toBe('g');
    expect(childGroupId({ id: 'g', projectId: 'p1' }, 'p2')).toBeNull();
    expect(childGroupId(null, 'p1')).toBeNull();
  });
});

describe('workstreams as shown', () => {
  it('finds the workstream a session is in', () => {
    const all = [w('a', ['1', '2']), w('b', ['3'])];
    expect(workstreamOf(all, '3')?.id).toBe('b');
    expect(workstreamOf(all, '9')).toBeNull();
  });

  it('lists only sessions in sight and drops a workstream with none, keeping untouched ones as they are', () => {
    const all = [w('a', ['1', '2']), w('b', ['3']), w('c', ['1'])];
    const shown = visibleWorkstreams(all, new Set(['1', '2']));
    expect(shown.map((x) => [x.id, x.sessionIds])).toEqual([['a', ['1', '2']], ['c', ['1']]]);
    expect(shown[0]).toBe(all[0]);
    expect(visibleWorkstreams(all, new Set(['2']))[0]).toMatchObject({ id: 'a', sessionIds: ['2'] });
  });

  it('cleans a name and an objective', () => {
    expect(workstreamName('  Invoice \n export  ')).toBe('Invoice export');
    expect(workstreamName('   ')).toBe('');
    expect(workstreamName('x'.repeat(200))).toHaveLength(WORKSTREAM_NAME_MAX);
    expect(workstreamObjective('  Ship it.\n')).toBe('Ship it.');
  });

  it('says in the orchestrator’s conversation what was connected', () => {
    expect(workstreamNotice('Invoice export', true, ['App B · Add export endpoint'])).toBe('Created the workstream “Invoice export” to connect this session with App B · Add export endpoint.');
    expect(workstreamNotice('Invoice export', false, ['A · one', 'B · two', 'C · three'])).toBe('Added A · one, B · two and C · three to the workstream “Invoice export”.');
  });

  it('says how many sessions in how many projects', () => {
    expect(workstreamSummary([s('p1'), s('p1'), s('p2', 'p1')])).toBe('3 sessions in 1 project');
    expect(workstreamSummary([s('p1'), s('p2')])).toBe('2 sessions in 2 projects');
    expect(workstreamSummary([s(null)])).toBe('1 session');
  });
});

describe('who is waiting on whom', () => {
  it('names an orchestrator with delegates still open, and nothing else', () => {
    const members = [
      { id: 'o', title: 'Orchestrator', state: 'done' as const },
      { id: 'a', title: 'A', state: 'running' as const },
      { id: 'b', title: 'B', state: 'attention' as const },
      { id: 'c', title: 'C', state: 'done' as const },
    ];
    const links = [
      { parentId: 'o', childId: 'a', kind: 'delegate' as const },
      { parentId: 'o', childId: 'b', kind: 'delegate' as const },
      { parentId: 'o', childId: 'c', kind: 'delegate' as const },
      { parentId: 'a', childId: 'gone', kind: 'delegate' as const },
      { parentId: 'c', childId: 'a', kind: 'handoff' as const },
    ];
    expect(waitingOn(members, links)).toEqual([{ sessionId: 'o', title: 'Orchestrator', count: 2 }]);
    expect(waitingOn(members.map((m) => ({ ...m, state: 'done' as const })), links)).toEqual([]);
  });
});

describe('how a workstream is drawn', () => {
  const link = (parentId: string, childId: string) => ({ id: `${parentId}-${childId}`, parentId, childId, kind: 'delegate' as const });

  it('has one lead, the first session, with what it started under it', () => {
    const shape = workstreamShape({ sessionIds: ['lead', 'a', 'b', 'a1'] }, [link('lead', 'a'), link('lead', 'b'), link('a', 'a1')]);
    expect(shape.leadId).toBe('lead');
    expect(shape.under.map((n) => [n.sessionId, n.children.map((c) => c.sessionId)])).toEqual([['a', ['a1']], ['b', []]]);
  });

  it('puts a member nothing here started beside the delegated ones, without inventing a parent', () => {
    const shape = workstreamShape({ sessionIds: ['lead', 'a', 'added'] }, [link('lead', 'a')]);
    expect(shape.under.map((n) => [n.sessionId, n.via])).toEqual([['a', 'delegate'], ['added', null]]);
  });

  it('passes the lead on when the first session has left, and has none when empty', () => {
    expect(workstreamShape({ sessionIds: ['a', 'b'] }, [link('gone', 'a'), link('gone', 'b')])).toMatchObject({ leadId: 'a', under: [{ sessionId: 'b' }] });
    expect(workstreamShape({ sessionIds: [] }, [])).toEqual({ leadId: null, under: [] });
  });

  it('counts the delegated sessions in words', () => {
    expect(delegatedText(1)).toBe('1 delegated session');
    expect(delegatedText(3)).toBe('3 delegated sessions');
  });
});

describe('complete, archive and restore', () => {
  it('splits the archived from the rest, most recently archived first', () => {
    const all = [{ id: 'a' }, { id: 'b', archivedAt: 5 }, { id: 'c', archivedAt: null }, { id: 'd', archivedAt: 9 }];
    const { active, archived } = splitArchived(all);
    expect(active.map((w) => w.id)).toEqual(['a', 'c']);
    expect(archived.map((w) => w.id)).toEqual(['d', 'b']);
  });
  it('keeps an archived workstream listed when every session in it is archived too', () => {
    const base = { name: 'n', objective: '', createdAt: 0, status: 'active' as const };
    const all = [
      { ...base, id: 'hidden', sessionIds: ['1'], archivedAt: null },
      { ...base, id: 'kept', sessionIds: ['1', '2'], archivedAt: 7 },
      { ...base, id: 'seen', sessionIds: ['2', '3'], archivedAt: null },
    ];
    const { active, archived } = shownWorkstreams(all, new Set(['3']));
    expect(active).toMatchObject([{ id: 'seen', sessionIds: ['3'] }]);
    expect(archived).toMatchObject([{ id: 'kept', sessionIds: ['1', '2'] }]);
  });
  it('a new message from the user brings an archived workstream back, and makes a complete one active', () => {
    expect(afterUserMessage({ status: 'complete', archivedAt: 5 })).toEqual({ patch: { status: 'active', archivedAt: null }, restored: true });
    expect(afterUserMessage({ status: 'active', archivedAt: 5 })).toEqual({ patch: { status: 'active', archivedAt: null }, restored: true });
    // Complete but still in the sidebar: active again, with nothing restored to say.
    expect(afterUserMessage({ status: 'complete', archivedAt: null })).toEqual({ patch: { status: 'active', archivedAt: null }, restored: false });
  });
  it('changes nothing for a workstream that is active and in the sidebar', () => {
    expect(afterUserMessage({ status: 'active', archivedAt: null })).toBeNull();
    expect(afterUserMessage({})).toBeNull();
  });
  it('archiving waits until no session in it is working or waiting on the user, naming each (Matt, 2026-11-19)', () => {
    const w = { name: 'Invoices', sessionIds: ['lead', 'a', 'b'] };
    const s = (id: string, state: string) => ({ id, title: id.toUpperCase(), state: state as 'running' });
    expect(archiveRefusal(w, [s('lead', 'done'), s('a', 'interrupted'), s('b', 'done')])).toBeNull();
    const one = archiveRefusal(w, [s('lead', 'done'), s('a', 'running'), s('b', 'done')])!;
    expect(one).toBe('“Invoices” can be archived once its sessions are done: “A” is still working or waiting on you. Answer or stop it first.');
    const two = archiveRefusal(w, [s('lead', 'attention'), s('a', 'running'), s('b', 'done')])!;
    expect(two).toContain('“LEAD” and “A” are still working');
  });
  it('a session archived by itself, or one outside the workstream, does not hold it back', () => {
    const w = { name: 'Invoices', sessionIds: ['lead', 'a'] };
    // `a` is archived, so it is not among the sessions in sight; `x` is running but not a member.
    expect(archiveRefusal(w, [{ id: 'lead', title: 'Lead', state: 'done' }, { id: 'x', title: 'X', state: 'running' }])).toBeNull();
    expect([isArchived({ archivedAt: 3 }), isArchived({ archivedAt: null }), isComplete({ status: 'complete' }), isComplete({})]).toEqual([true, false, true, false]);
  });
});

describe('the lead marking its workstream complete (complete_workstream)', () => {
  const ws = { name: 'Invoices', sessionIds: ['lead', 'a', 'b'] };
  const members = (a: string, b: string) => [
    { id: 'lead', title: 'Plan invoices', state: 'running' as const },
    { id: 'a', title: 'Export endpoint', state: a as 'running' },
    { id: 'b', title: 'Download button', state: b as 'running' },
  ];

  it('the lead is the first session in it', () => {
    expect(leadOf(ws)).toBe('lead');
    expect(leadOf({ sessionIds: [] })).toBeNull();
  });
  it('lets the lead mark it complete when nothing else in it is still open', () => {
    expect(completeRefusal(ws, 'lead', members('done', 'interrupted'))).toBeNull();
  });
  it('refuses a session in no workstream, saying there is nothing to complete', () => {
    expect(completeRefusal(null, 'lead', [])).toMatch(/not in a workstream/);
  });
  it('refuses any session but the lead, naming the lead', () => {
    const reason = completeRefusal(ws, 'a', members('done', 'done'));
    expect(reason).toMatch(/Only the lead of “Invoices”/);
    expect(reason).toContain('Plan invoices');
    expect(reason).toContain('(lead)');
  });
  it('refuses while sessions in it are working or waiting on the user, naming each', () => {
    const reason = completeRefusal(ws, 'lead', members('running', 'attention'))!;
    expect(reason).toContain('“Export endpoint” (a)');
    expect(reason).toContain('“Download button” (b)');
    expect(reason).toMatch(/session_status/);
    expect(completeRefusal(ws, 'lead', members('done', 'attention'))).toContain('Download button');
  });
  it('counts working and waiting on the user as open work, and nothing else', () => {
    expect(['running', 'attention', 'done', 'interrupted'].map((state) => isOpenWork({ state: state as 'running' }))).toEqual([true, true, false, false]);
  });
});

describe('a workstream drawn as one tree', () => {
  const session = (id: string, state: string, at: number) => ({ id, state: state as never, note: '', updatedAt: at, lastActivityAt: at });
  const link = (parentId: string, childId: string) => ({ id: `${parentId}>${childId}`, parentId, childId, kind: 'delegate' as const });
  const tree = (sessions: ReturnType<typeof session>[], links: ReturnType<typeof link>[], ids = sessions.map((x) => x.id)) => workstreamRows({ sessionIds: ids }, links, sessions).map((r) => `${'  '.repeat(r.depth)}${r.session.id}`);

  it('puts the lead first and the sessions it started under it, each with its own', () => {
    const links = [link('lead', 'a'), link('lead', 'b'), link('a', 'a1')];
    expect(tree([session('lead', 'done', 1), session('a', 'done', 3), session('b', 'done', 2), session('a1', 'done', 1)], links)).toEqual(['lead', '  a', '    a1', '  b']);
  });

  it('lifts what needs the user, then what is working, to the top of its level; the latest first within each', () => {
    const links = [link('lead', 'idle'), link('lead', 'working'), link('lead', 'asks'), link('lead', 'failed'), link('lead', 'older')];
    const rows = tree([session('lead', 'running', 1), session('idle', 'done', 90), session('working', 'running', 10), session('asks', 'attention', 5), session('failed', 'attention', 7), session('older', 'done', 20)], links);
    expect(rows).toEqual(['lead', '  failed', '  asks', '  working', '  idle', '  older']);
  });

  it('places a session by the most urgent thing under it, and orders its own children the same way', () => {
    const links = [link('lead', 'quiet'), link('lead', 'parent'), link('parent', 'done-child'), link('parent', 'asking-child')];
    const rows = tree([session('lead', 'done', 1), session('quiet', 'done', 99), session('parent', 'done', 2), session('done-child', 'done', 50), session('asking-child', 'attention', 3)], links);
    expect(rows).toEqual(['lead', '  parent', '    asking-child', '    done-child', '  quiet']);
  });

  it('keeps a member nothing here started at the first level, and leaves out a session that is gone', () => {
    const links = [link('lead', 'a'), link('a', 'a1')];
    // `loose` was added to the workstream by hand; `a` was archived, so its child moves up a level.
    expect(tree([session('lead', 'done', 1), session('loose', 'done', 5), session('a1', 'done', 2)], links, ['lead', 'a', 'a1', 'loose'])).toEqual(['lead', '  loose', '  a1']);
    expect(workstreamRows({ sessionIds: [] }, [], [])).toEqual([]);
  });
});

