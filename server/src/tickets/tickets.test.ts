// Tickets (docs/designs/tickets.md): the one order, which ticket a session works on, criteria in a
// description, the store's dismissed, read and attached tickets, and the sync. Every tracker here is the scripted one: no test reaches a real tracker.
import { describe, expect, it } from 'vitest';
import { ready, unavailable } from '../shared/sourced.ts';
import { hasTicketLink, hasTicketSection, ticketLead, ticketsUnderWay, asTicketSettings, asTicketsView, sourceIdOf, ticketSourceOn, withTicketSource, type TicketSourceId, choicesOf, criteriaOf, filterTickets, isFilteringTickets, NO_TICKET_FILTERS, ticketOf, TICKETS_OFF_REASON, ticketOrder, ticketsOn, type Ticket } from '../shared/tickets.ts';
import { fakeTicketSource, sampleDetail, sampleSeenKeys, sampleTicketLinks, sampleTickets } from './sources/fake.ts';
import { TicketStore } from './store.ts';
import { syncTickets } from './sync.ts';
import { moveTicket } from './move.ts';
import { Refused } from '../refused.ts';

/** Tickets turned on in Settings → Tickets, as the tests of a working list need. */
const ON = { settings: { on: true, off: [], show: 'page' as const } };

const NOW = Date.parse('2026-11-22T12:00:00Z');

const ticket = (ref: string, over: Partial<Ticket> = {}): Ticket => ({
  key: `fake:${ref}`,
  source: 'fake',
  tracker: 'Sample',
  ref,
  title: ref,
  status: { name: 'To Do', category: 'todo' },
  project: 'Platform',
  url: '',
  openedAt: 0,
  updatedAt: 0,
  ...over,
});

describe('ticketOrder', () => {
  it('lists the current sprint first under its name, then the rest, most urgent then newest', () => {
    const groups = ticketOrder([
      ticket('A', { priority: 3, updatedAt: 5 }),
      ticket('B', { sprint: { name: 'Sprint 24', current: true }, priority: 3, updatedAt: 1 }),
      ticket('C', { sprint: { name: 'Sprint 24', current: true }, priority: 1, updatedAt: 0 }),
      ticket('D', { sprint: { name: 'Sprint 25', current: false }, priority: 2 }),
      ticket('E', { updatedAt: 9 }),
    ]);
    expect(groups.map((g) => [g.sprint, g.tickets.map((t) => t.ref)])).toEqual([
      ['Sprint 24', ['C', 'B']],
      [null, ['D', 'A', 'E']],
    ]);
  });

  it('is one list when nothing is in a current sprint, and one group when everything is', () => {
    expect(ticketOrder([ticket('A')]).map((g) => g.sprint)).toEqual([null]);
    expect(ticketOrder([ticket('A', { sprint: { name: 'S', current: true } })]).map((g) => g.sprint)).toEqual(['S']);
    expect(ticketOrder([])).toEqual([{ sprint: null, tickets: [] }]);
  });
});

describe('ticketOf', () => {
  const links = [
    { ticketKey: 'fake:A', attachedTo: 'session' as const, id: 's1', role: 'lead' as const, at: 1 },
    { ticketKey: 'fake:B', attachedTo: 'workstream' as const, id: 'w1', role: 'lead' as const, at: 1 },
  ];
  it('is the session’s own ticket, else its workstream’s, read through and never copied', () => {
    const streams = [{ id: 'w1', sessionIds: ['s2', 's3'] }, { id: 'w2', sessionIds: ['s1', 's4'] }];
    expect(ticketOf('s1', links, streams)?.ticketKey).toBe('fake:A');
    expect(ticketOf('s3', links, streams)?.ticketKey).toBe('fake:B');
    // A session in the lead's workstream works on the lead's ticket.
    expect(ticketOf('s4', links, streams)?.ticketKey).toBe('fake:A');
    expect(ticketOf('s9', links, streams)).toBeNull();
  });
});

describe('criteriaOf', () => {
  it('reads the list under an acceptance criteria heading, up to the next heading', () => {
    expect(criteriaOf('Intro\n\n## Acceptance criteria\n\n- [ ] One\n- Two\n1. Three\n\n## Notes\n- not this')).toEqual(['One', 'Two', 'Three']);
    expect(criteriaOf('h3. Acceptance Criteria\n* Jira style')).toEqual(['Jira style']);
    expect(criteriaOf('No criteria here\n- a list')).toEqual([]);
  });
});

describe('TicketStore', () => {
  it('orders, counts unread, dismisses with the keys kept, and keeps a list when a source fails', () => {
    const saved: Record<string, unknown> = {};
    const store = new TicketStore({ ...ON, saveDismissed: (k) => (saved.dismissed = k), saveSeen: (k) => (saved.seen = k) });
    const heard: number[] = [];
    store.onChange((v) => heard.push(v.tickets.length));
    store.set('fake', ready(sampleTickets(NOW)));
    const first = store.view();
    expect(first.tickets.map((t) => t.ref).slice(0, 2)).toEqual(['BELL-142', 'PLAT-318']);
    expect(first.unread).toHaveLength(sampleTickets(NOW).length);
    store.dismiss(['fake:BELL-142'], true);
    expect(store.view().tickets.some((t) => t.ref === 'BELL-142')).toBe(false);
    expect(store.view().dismissed.map((t) => t.ref)).toEqual(['BELL-142']);
    expect(saved.dismissed).toEqual(['fake:BELL-142']);
    expect(store.view().unread).not.toContain('fake:BELL-142');
    store.set('fake', unavailable('The tracker is down'));
    expect(store.view().tickets.length).toBe(first.tickets.length - 1);
    expect(store.view().problems).toEqual([{ source: 'fake', reason: 'The tracker is down' }]);
    // The same answer again is not pushed again.
    const pushes = heard.length;
    store.set('fake', unavailable('The tracker is down'));
    expect(heard.length).toBe(pushes);
  });

  it('keeps an attached ticket after it leaves the list, and gives each session one ticket', () => {
    const saved: unknown[] = [];
    const store = new TicketStore({ ...ON, saveLinks: (l) => saved.push(l) });
    store.set('fake', ready([ticket('A'), ticket('B')]));
    store.attach({ ticketKey: 'fake:A', attachedTo: 'session', id: 's1', role: 'lead', at: 1 });
    expect(store.view().unread).not.toContain('fake:A');
    store.attach({ ticketKey: 'fake:B', attachedTo: 'session', id: 's1', role: 'lead', at: 2 });
    expect(store.view().links.map((l) => l.ticketKey)).toEqual(['fake:B']);
    store.set('fake', ready([ticket('A')]));
    expect(store.view().attached.map((t) => t.ref)).toEqual(['B']);
    store.detach('session', 's1');
    expect(store.view().links).toEqual([]);
    expect(saved).toHaveLength(3);
  });

  it('holds a ticket’s detail, keeping a good answer over a failed one', () => {
    const store = new TicketStore(ON);
    store.loading('k');
    expect(store.view().details.k).toEqual({ state: 'loading' });
    store.setDetail('k', ready({ description: 'd', criteria: [], comments: [] }));
    store.setDetail('k', unavailable('down'));
    expect(store.view().details.k?.state).toBe('ready');
  });

  it('pushes a view the page can read back whole', () => {
    const store = new TicketStore(ON);
    store.set('fake', ready(sampleTickets(NOW)));
    store.attach({ ticketKey: 'fake:PLAT-318', attachedTo: 'session', id: 's1', role: 'lead', at: 1 });
    store.setDetail('fake:PLAT-318', ready(sampleDetail('PLAT-318', NOW)!));
    const view = JSON.parse(JSON.stringify(store.view()));
    expect(asTicketsView(view)).toEqual(store.view());
  });
});

describe('syncTickets', () => {
  it('asks every source, drops one no longer asked with its tickets’ details, and reads a ticket’s detail on request', async () => {
    const store = new TicketStore(ON);
    let sources = [fakeTicketSource(() => NOW)];
    const sync = syncTickets(async () => sources, store, () => true, () => NOW, false);
    await sync.check();
    expect(store.view().tickets).toHaveLength(sampleTickets(NOW).length);
    await sync.read('fake:BELL-142');
    const detail = store.view().details['fake:BELL-142'];
    expect(detail?.state === 'ready' && detail.value.criteria).toHaveLength(4);
    sources = [];
    await sync.check();
    expect(store.view().tickets).toEqual([]);
    // Its detail goes with it: nothing shows it now, and each round reads only what can be shown.
    expect(store.view().details['fake:BELL-142']).toBeUndefined();
  });
});

describe('filterTickets', () => {
  it('filters by tracker, project, status, priority and a forgiving search', () => {
    const all = sampleTickets(NOW);
    expect(filterTickets(all, { ...NO_TICKET_FILTERS, project: 'Platform' }).map((t) => t.ref)).toEqual(['PLAT-318', 'PLAT-301']);
    expect(filterTickets(all, { ...NO_TICKET_FILTERS, category: 'in-progress' }).map((t) => t.ref)).toEqual(['PLAT-318']);
    expect(filterTickets(all, { ...NO_TICKET_FILTERS, text: 'total CART' }).map((t) => t.ref)).toEqual(['BELL-142']);
    expect(choicesOf(all, 'priorityName')).toEqual(['High', 'Medium', 'Low']);
    expect(isFilteringTickets(NO_TICKET_FILTERS)).toBe(false);
  });
});

describe('withoutCriteria and statusWords', () => {
  it('takes the criteria block out of a description, and says a status once', async () => {
    const { withoutCriteria, statusWords } = await import('../shared/tickets.ts');
    expect(withoutCriteria('Why\n\n## Acceptance criteria\n- One\n\n## Notes\nMore')).toBe('Why\n\n## Notes\nMore');
    expect(withoutCriteria('No criteria')).toBe('No criteria');
    expect(statusWords({ name: 'To Do', category: 'todo' })).toBe('To Do');
    expect(statusWords({ name: 'Backlog', category: 'todo' })).toBe('Backlog (To do)');
  });
});

describe('the sample tracker', () => {
  it('starts a fresh demo with a couple of tickets new, the rest read', () => {
    const store = new TicketStore({ ...ON, seen: sampleSeenKeys() });
    store.set('fake', ready(sampleTickets(Date.now())));
    expect(store.view().unread).toEqual(['fake:BELL-142', 'fake:PLAT-318']);
  });
});

describe('tickets off (Settings → Tickets)', () => {
  it('are off by default, and anything malformed reads as off', () => {
    expect(ticketsOn(new TicketStore().view())).toBe(false);
    expect(ticketsOn(asTicketsView({}))).toBe(false);
    expect(asTicketSettings({ on: 'yes' })).toEqual({ on: false, off: [], show: 'page' as const });
    expect(asTicketSettings({ on: true })).toEqual({ on: true, off: [], show: 'page' as const });
  });

  it('ask no tracker, list nothing, and count nothing new', async () => {
    let asked = 0;
    const source = { ...fakeTicketSource(() => NOW), assignedToMe: async () => (asked++, ready(sampleTickets(NOW))) };
    const store = new TicketStore();
    const sync = syncTickets(async () => [source], store, () => true, () => NOW, false);
    await sync.tick();
    await sync.check();
    await sync.read('fake:BELL-142');
    expect(asked).toBe(0);
    expect(store.view().tickets).toEqual([]);
    expect(store.view().unread).toEqual([]);
    expect(store.view().details['fake:BELL-142']).toMatchObject({ state: 'unavailable' });
  });

  it('keep the ticket on work that has one, and list again when turned back on', async () => {
    const saved: { on: boolean; off: string[] }[] = [];
    const store = new TicketStore({ ...ON, saveSettings: (s) => saved.push(s) });
    store.set('fake', ready(sampleTickets(NOW)));
    store.attach({ ticketKey: 'fake:BELL-142', attachedTo: 'session', id: 's1', role: 'lead', at: NOW });
    store.setSettings({ on: false, off: [], show: 'page' as const });
    expect(store.view().tickets).toEqual([]);
    expect(store.view().attached.map((t) => t.ref)).toEqual(['BELL-142']);
    store.setSettings({ on: true, off: [], show: 'page' as const });
    expect(store.view().tickets.length).toBe(6);
    expect(saved).toEqual([{ on: false, off: [], show: 'page' as const }, { on: true, off: [], show: 'page' as const }]);
  });

  it('refuse the routes that would ask a tracker, with where to turn them on', async () => {
    const { ticketsRoute } = await import('./api.ts');
    const store = new TicketStore();
    const sync = syncTickets(async () => [], store, () => true, () => NOW, false);
    const api = { store, sync, work: {} as never };
    await expect(ticketsRoute(['api', 'tickets', 'refresh'], 'POST', new URL('http://x/'), async () => ({}), api)).rejects.toThrow(TICKETS_OFF_REASON);
    const turned = await ticketsRoute(['api', 'tickets', 'settings'], 'PUT', new URL('http://x/'), async () => ({ on: true }), api);
    expect(turned).toEqual({ status: 200, body: { on: true, off: [], show: 'page' as const } });
    expect(ticketsOn(store.view())).toBe(true);
    const placed = await ticketsRoute(['api', 'tickets', 'settings'], 'PUT', new URL('http://x/'), async () => ({ show: 'both' }), api);
    expect(placed).toEqual({ status: 200, body: { on: true, off: [], show: 'both' } });
    const wrong = await ticketsRoute(['api', 'tickets', 'settings'], 'PUT', new URL('http://x/'), async () => ({ show: 'drawer' }), api);
    expect(wrong?.status).toBe(400);
  });
});

describe('ticket sources switched on and off (Settings → Tickets → Sources)', () => {
  const settings = (off: TicketSourceId[] = [], on = true) => ({ on, off, show: 'page' as const });

  it('decides with one function: tickets on, and the source not switched off', () => {
    expect(sourceIdOf('gitlab@gitlab.example.com')).toBe('gitlab');
    expect(sourceIdOf('jira')).toBe('jira');
    expect(sourceIdOf('fake')).toBeNull();
    expect(ticketSourceOn(settings(), 'github')).toBe(true);
    expect(ticketSourceOn(settings(['gitlab']), 'gitlab@gitlab.example.com')).toBe(false);
    expect(ticketSourceOn(settings([], false), 'github')).toBe(false);
    expect(ticketSourceOn(settings(['gitlab', 'github', 'jira']), 'fake')).toBe(true);
    expect(withTicketSource(settings(['jira']), 'gitlab', false)).toEqual(settings(['gitlab', 'jira']));
    expect(withTicketSource(settings(['jira']), 'jira', true)).toEqual(settings());
    expect(asTicketSettings({ on: true, off: ['jira', 'nope'], show: 'page' as const })).toEqual(settings(['jira']));
  });

  it('shows tickets on their page by default, in the sidebar or both, and nowhere while off', () => {
    expect(asTicketSettings({ on: true }).show).toBe('page');
    expect(asTicketSettings({ on: true, show: 'everywhere' }).show).toBe('page');
    expect(asTicketSettings({ on: true, show: 'both' }).show).toBe('both');
    expect([hasTicketSection(settings()), hasTicketLink(settings())]).toEqual([false, true]);
    expect([hasTicketSection({ on: true, show: 'sidebar' }), hasTicketLink({ on: true, show: 'sidebar' })]).toEqual([true, false]);
    expect([hasTicketSection({ on: true, show: 'both' }), hasTicketLink({ on: true, show: 'both' })]).toEqual([true, true]);
    expect([hasTicketSection({ on: false, show: 'both' }), hasTicketLink({ on: false, show: 'both' })]).toEqual([false, false]);
  });

  it('never asks a source that is off, and its tickets leave the list while attached ones keep their chip', async () => {
    const asked: string[] = [];
    const sourceOf = (kind: string, tickets: Ticket[]) => ({ kind, name: kind, assignedToMe: async () => (asked.push(kind), ready(tickets)), read: async () => unavailable('no'), status: async () => unavailable('no'), statuses: async () => unavailable('no'), move: async () => Promise.reject(new Error('no')), comment: async () => Promise.reject(new Error('no')) });
    const store = new TicketStore(ON);
    const sync = syncTickets(async () => [sourceOf('github', [ticket('hooks#12', { key: 'github:acme/hooks#12', source: 'github' })]), sourceOf('jira', [ticket('OPS-1', { key: 'jira:OPS-1', source: 'jira' })])], store, () => true, () => NOW, false);
    await sync.check();
    expect(store.view().tickets.map((t) => t.ref).sort()).toEqual(['OPS-1', 'hooks#12']);
    store.attach({ ticketKey: 'jira:OPS-1', attachedTo: 'session', id: 's1', role: 'lead', at: NOW });
    store.setSettings(settings(['jira']));
    expect(store.view().tickets.map((t) => t.ref)).toEqual(['hooks#12']);
    expect(store.view().attached.map((t) => t.ref)).toEqual(['OPS-1']);
    asked.length = 0;
    await sync.check();
    expect(asked).toEqual(['github']);
    await sync.read('jira:OPS-1');
    expect(store.view().details['jira:OPS-1']).toMatchObject({ state: 'unavailable' });
  });
});

describe('moving a ticket (moveTicket, one function for every move)', () => {
  const setUp = async () => {
    const store = new TicketStore(ON);
    const source = fakeTicketSource(() => NOW);
    const sync = syncTickets(async () => [source], store, () => true, () => NOW, false);
    await sync.check();
    return { store, deps: { store, sourceOf: sync.sourceOf } };
  };

  it('moves it, holds the new status at once, and says the status it left so Undo can move it back', async () => {
    const { store, deps } = await setUp();
    const moved = await moveTicket(deps, 'fake:BELL-142', 'In Progress');
    expect(moved).toEqual({ key: 'fake:BELL-142', ref: 'BELL-142', from: { name: 'To Do', category: 'todo' }, to: { name: 'In Progress', category: 'in-progress' } });
    expect(store.ticket('fake:BELL-142')?.status.name).toBe('In Progress');
    expect(store.view().tickets.find((t) => t.ref === 'BELL-142')?.status.name).toBe('In Progress');
    await moveTicket(deps, 'fake:BELL-142', moved.from.name);
    expect(store.ticket('fake:BELL-142')?.status.name).toBe('To Do');
  });

  it('refuses with the tracker’s reason, and while tickets or the source are off', async () => {
    const { store, deps } = await setUp();
    await expect(moveTicket(deps, 'fake:BELL-142', 'Shipped')).rejects.toThrow('no status “Shipped”');
    await expect(moveTicket(deps, 'fake:BELL-142', 'To Do')).rejects.toThrow('already To Do');
    await expect(moveTicket(deps, 'fake:NOPE-1', 'Done')).rejects.toThrow(Refused);
    store.setSettings({ on: false, off: [], show: 'page' as const });
    await expect(moveTicket(deps, 'fake:BELL-142', 'Done')).rejects.toThrow(TICKETS_OFF_REASON);
  });
});

describe('ticketsUnderWay (Kestrel’s own fact, apart from the tracker’s status)', () => {
  it('is a ticket attached to a session or workstream the workspace still lists', () => {
    const links = [
      { ticketKey: 'fake:A', attachedTo: 'session' as const, id: 's1', role: 'lead' as const, at: 0 },
      { ticketKey: 'fake:B', attachedTo: 'workstream' as const, id: 'w1', role: 'lead' as const, at: 0 },
      { ticketKey: 'fake:C', attachedTo: 'session' as const, id: 'archived-session', role: 'lead' as const, at: 0 },
      { ticketKey: 'fake:D', attachedTo: 'workstream' as const, id: 'archived-stream', role: 'lead' as const, at: 0 },
    ];
    expect([...ticketsUnderWay(links, new Set(['s1']), new Set(['w1']))].sort()).toEqual(['fake:A', 'fake:B']);
    expect(ticketsUnderWay([], new Set(['s1']), new Set())).toEqual(new Set());
  });

  it('has sample tickets under way in the tickets demo: one on a session, one on the checkout workstream when it is there', () => {
    expect(sampleTicketLinks(NOW)).toEqual([{ ticketKey: 'fake:BELL-120', attachedTo: 'session', id: 'search', role: 'lead', at: NOW }]);
    expect(sampleTicketLinks(NOW, [{ id: 'w1', name: 'Checkout latency' }])).toEqual([
      { ticketKey: 'fake:BELL-120', attachedTo: 'session', id: 'search', role: 'lead', at: NOW },
      { ticketKey: 'fake:PLAT-318', attachedTo: 'workstream', id: 'w1', role: 'lead', at: NOW },
    ]);
  });
});

describe('the session leading a ticket', () => {
  const link = (attachedTo: 'session' | 'workstream', id: string, role: 'lead' | 'part' = 'lead') => ({ ticketKey: 'fake:A-1', attachedTo, id, role, at: NOW });
  const streams = [{ id: 'w1', sessionIds: ['s-lead', 's-part'] }];
  it('is its lead session, else its workstream’s lead, and only while that session exists', () => {
    expect(ticketLead('fake:A-1', [link('session', 's1')], streams, new Set(['s1']))).toBe('s1');
    expect(ticketLead('fake:A-1', [link('workstream', 'w1')], streams, new Set(['s-lead']))).toBe('s-lead');
    expect(ticketLead('fake:A-1', [link('session', 'gone'), link('workstream', 'w1')], streams, new Set(['s-lead']))).toBe('s-lead');
    expect(ticketLead('fake:A-1', [link('session', 's1', 'part')], streams, new Set(['s1']))).toBeNull();
    expect(ticketLead('fake:A-1', [link('workstream', 'w1')], streams, new Set())).toBeNull();
    expect(ticketLead('fake:B-2', [link('session', 's1')], streams, new Set(['s1']))).toBeNull();
  });
});
