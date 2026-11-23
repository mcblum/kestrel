// Closed tickets (docs/designs/tickets.md, section 4a): a ticket Kestrel held that leaves its source's
// list is asked about on its own, and kept in Closed only when its tracker says it is done. The
// trackers are scripted; nothing reaches a real one.
import { describe, expect, it } from 'vitest';
import { Refused } from '../refused.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { asClosedTickets, closedElsewhere, closedHereMark, CLOSED_TICKET_LIMIT, doneHere, findTicket, keptClosed, marksDone, type ClosedTicket, type Ticket, type TicketMove } from '../shared/tickets.ts';
import { fakeTicketSource } from './sources/fake.ts';
import type { TicketSource } from './source.ts';
import { TicketStore, type TicketStoreOptions } from './store.ts';
import { syncTickets } from './sync.ts';
import { workTicket } from './work.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const ON = { settings: { on: true, off: [], show: 'page' as const } };
const DONE: TicketMove = { name: 'Done', category: 'done' };

const ticket = (ref: string, source = 'jira'): Ticket => ({
  key: `${source}:${ref}`,
  source,
  tracker: 'Jira',
  ref,
  title: `Ticket ${ref}`,
  status: { name: 'To Do', category: 'todo' },
  project: 'Platform',
  url: '',
  openedAt: NOW - 1000,
  updatedAt: NOW - 500,
  sprint: null,
});

/** A scripted tracker: `listed` is what it lists, `statuses` what it says of one ticket (absent: it cannot answer). */
function tracker(kind = 'jira') {
  const state = { listed: [] as Ticket[], statuses: new Map<string, TicketMove>(), asked: [] as string[], down: false };
  const source: TicketSource = {
    kind,
    name: kind,
    assignedToMe: async (): Promise<Sourced<Ticket[]>> => (state.down ? unavailable('Jira is down') : ready(state.listed)),
    status: async (t) => {
      state.asked.push(t.ref);
      const s = state.statuses.get(t.ref);
      return s ? ready(s) : unavailable('Jira did not answer');
    },
    read: async () => unavailable('no'),
    statuses: async () => ready([]),
    move: async () => Promise.reject(new Error('no')),
    comment: async () => Promise.reject(new Error('no')),
  };
  return { state, source };
}

const setup = (options: TicketStoreOptions = {}, sources = [tracker()]) => {
  const store = new TicketStore({ ...ON, ...options });
  let now = NOW;
  const sync = syncTickets(async () => sources.map((s) => s.source), store, () => true, () => now, false);
  return { store, sync, sources, later: (ms: number) => (now += ms) };
};

describe('a ticket that leaves the list', () => {
  it('is kept in Closed when its tracker says it is done, with when it closed; never listed, unread or counted', async () => {
    const saved: ClosedTicket[][] = [];
    const { store, sync, sources, later } = setup({ saveClosed: (c) => saved.push([...c]) });
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1'), ticket('PLAT-2')];
    await sync.check();
    expect(store.view().unread).toEqual(['jira:PLAT-1', 'jira:PLAT-2']);
    jira!.state.listed = [ticket('PLAT-2')];
    jira!.state.statuses.set('PLAT-1', DONE);
    later(60_000);
    await sync.check();
    expect(jira!.state.asked).toEqual(['PLAT-1']);
    const view = store.view();
    expect(view.closed).toEqual([{ ...ticket('PLAT-1'), status: DONE, closedAt: NOW + 60_000 }]);
    expect(view.tickets.map((t) => t.ref)).toEqual(['PLAT-2']);
    expect(view.unread).toEqual(['jira:PLAT-2']);
    expect(findTicket(view, 'jira:PLAT-1')?.status).toEqual(DONE);
    expect(saved.at(-1)?.map((t) => t.ref)).toEqual(['PLAT-1']);
    // Asked once: the next round does not ask about it again.
    await sync.check();
    expect(jira!.state.asked).toEqual(['PLAT-1']);
  });

  it('goes when its tracker says it is not done: it was reassigned', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    jira!.state.listed = [];
    jira!.state.statuses.set('PLAT-1', { name: 'In Progress', category: 'in-progress' });
    await sync.check();
    expect(store.view().closed).toEqual([]);
    expect(findTicket(store.view(), 'jira:PLAT-1')).toBeUndefined();
    expect(store.leavingOf('jira')).toEqual([]);
  });

  it('is decided by nothing when the ask fails: asked again next round, neither dropped nor closed', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    jira!.state.listed = [];
    await sync.check();
    expect(store.view().closed).toEqual([]);
    expect(store.leavingOf('jira').map((t) => t.ref)).toEqual(['PLAT-1']);
    jira!.state.statuses.set('PLAT-1', DONE);
    await sync.check();
    expect(jira!.state.asked).toEqual(['PLAT-1', 'PLAT-1']);
    expect(store.view().closed.map((t) => t.ref)).toEqual(['PLAT-1']);
  });

  it('is not leaving when the list could not be had: a failed answer says nothing about what left', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    jira!.state.down = true;
    await sync.check();
    expect(store.leavingOf('jira')).toEqual([]);
    expect(jira!.state.asked).toEqual([]);
  });

  it('leaves Closed when its tracker lists it again (reopened)', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    jira!.state.listed = [];
    jira!.state.statuses.set('PLAT-1', DONE);
    await sync.check();
    expect(store.view().closed).toHaveLength(1);
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    expect(store.view().closed).toEqual([]);
    expect(store.view().tickets.map((t) => t.ref)).toEqual(['PLAT-1']);
  });

  it('is asked about again when reopened from Kestrel and not listed: reopened for someone else, it goes', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    jira!.state.listed = [];
    jira!.state.statuses.set('PLAT-1', DONE);
    await sync.check();
    store.setStatus('jira:PLAT-1', { name: 'To Do', category: 'todo' });
    expect(store.view().closed[0]!.status.name).toBe('To Do'); // shown at once, until the tracker answers
    jira!.state.statuses.set('PLAT-1', { name: 'To Do', category: 'todo' });
    await sync.check();
    expect(store.view().closed).toEqual([]);
  });

  it('counts a dismissed ticket as held, and keeps an attached closed one in Closed rather than in attached', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1'), ticket('PLAT-2')];
    await sync.check();
    store.dismiss(['jira:PLAT-1'], true);
    store.attach({ ticketKey: 'jira:PLAT-2', attachedTo: 'session', id: 's1', role: 'lead', at: NOW });
    jira!.state.listed = [];
    jira!.state.statuses.set('PLAT-1', DONE).set('PLAT-2', DONE);
    await sync.check();
    expect(store.view().closed.map((t) => t.ref).sort()).toEqual(['PLAT-1', 'PLAT-2']);
    expect(store.view().dismissed).toEqual([]);
    expect(store.view().attached).toEqual([]);
  });
});

describe('closed tickets, kept and shown', () => {
  it('are not shown while their source is switched off or tickets are off', async () => {
    const { store, sync, sources } = setup();
    const [jira] = sources;
    jira!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    jira!.state.listed = [];
    jira!.state.statuses.set('PLAT-1', DONE);
    await sync.check();
    store.setSettings({ on: true, off: ['jira'], show: 'page' });
    expect(store.view().closed).toEqual([]);
    store.setSettings({ on: false, off: [], show: 'page' });
    expect(store.view().closed).toEqual([]);
    store.setSettings({ on: true, off: [], show: 'page' });
    expect(store.view().closed.map((t) => t.ref)).toEqual(['PLAT-1']);
  });

  it('outlive a restart, and a ticket that closed while Kestrel was not running is found on the first answer', async () => {
    let held: readonly Ticket[] = [];
    let closed: readonly ClosedTicket[] = [];
    const first = setup({ saveHeld: (t) => (held = t), saveClosed: (c) => (closed = c) });
    first.sources[0]!.state.listed = [ticket('PLAT-1'), ticket('PLAT-2'), ticket('PLAT-3')];
    await first.sync.check();
    first.sources[0]!.state.listed = [ticket('PLAT-2'), ticket('PLAT-3')];
    first.sources[0]!.state.statuses.set('PLAT-1', DONE);
    await first.sync.check();
    expect(held.map((t) => t.ref)).toEqual(['PLAT-2', 'PLAT-3']);

    // The app stops; PLAT-2 is closed in Jira meanwhile.
    const second = setup({ held: JSON.parse(JSON.stringify(held)), closed: asClosedTickets(JSON.parse(JSON.stringify(closed))) });
    expect(second.store.view().closed.map((t) => t.ref)).toEqual([]); // no source asked yet
    second.sources[0]!.state.listed = [ticket('PLAT-3')];
    second.sources[0]!.state.statuses.set('PLAT-2', DONE);
    second.later(3_600_000);
    await second.sync.check();
    expect(second.store.view().closed.map((t) => t.ref)).toEqual(['PLAT-2', 'PLAT-1']);
  });

  it('are the newest hundred by when they closed', () => {
    const many = Array.from({ length: CLOSED_TICKET_LIMIT + 5 }, (_, i) => ({ ...ticket(`P-${i}`), closedAt: NOW + i }));
    const kept = keptClosed([...many, { ...many[0]!, closedAt: NOW + 1000 }]);
    expect(kept).toHaveLength(CLOSED_TICKET_LIMIT);
    expect(kept[0]).toMatchObject({ ref: 'P-0', closedAt: NOW + 1000 });
    expect(kept.some((t) => t.ref === 'P-5')).toBe(false);
    expect(asClosedTickets([{ ...ticket('X-1') }, 'junk'])).toEqual([]); // no closedAt: not a closed ticket
  });

  it('are not worked: Work this ticket refuses one with no lead', async () => {
    const { store, sync, sources } = setup();
    sources[0]!.state.listed = [ticket('PLAT-1')];
    await sync.check();
    sources[0]!.state.listed = [];
    sources[0]!.state.statuses.set('PLAT-1', DONE);
    await sync.check();
    const deps = { store, projects: async () => [], sessions: async () => [], originOf: async () => null, read: async () => undefined, start: async () => Promise.reject(new Error('not started')), tag: async () => undefined };
    await expect(workTicket(deps, 'jira:PLAT-1', { agent: 'claude' })).rejects.toBeInstanceOf(Refused);
  });
});

describe('the sample tracker', () => {
  it('drops a ticket moved to Done from its list, and the sync finds it closed', async () => {
    const source = fakeTicketSource(() => NOW);
    const store = new TicketStore(ON);
    const sync = syncTickets(async () => [source], store, () => true, () => NOW, false);
    await sync.check();
    const bell = store.ticket('fake:BELL-142')!;
    store.setStatus(bell.key, await source.move(bell, 'Done'), NOW);
    await sync.check();
    expect(store.view().tickets.some((t) => t.ref === 'BELL-142')).toBe(false);
    // Marked done here: it keeps that mark, and when the user did it, once its tracker confirms.
    expect(store.view().closed).toEqual([expect.objectContaining({ ref: 'BELL-142', status: DONE, doneHere: true })]);
  });
});

describe('a ticket the user marked done here', () => {
  const TODO: TicketMove = { name: 'To Do', category: 'todo' };

  it('is in Done at once, out of the waiting list and never unread, while its tracker still lists it', async () => {
    const { store, sync, sources } = setup();
    sources[0]!.state.listed = [ticket('A-1'), ticket('A-2')];
    await sync.check();

    store.setStatus('jira:A-1', DONE, NOW + 10);

    const view = store.view();
    expect(view.tickets.map((t) => t.ref)).toEqual(['A-2']);
    expect(view.unread).toEqual(['jira:A-2']);
    expect(view.closed.map((t) => [t.ref, t.doneHere, t.closedAt])).toEqual([['A-1', true, NOW + 10]]);
  });

  it('stays in Done when its tracker lists it as done, and when it then leaves the list and is found closed', async () => {
    const { store, sync, sources, later } = setup();
    sources[0]!.state.listed = [ticket('A-1')];
    await sync.check();
    store.setStatus('jira:A-1', DONE, NOW + 10);

    sources[0]!.state.listed = [{ ...ticket('A-1'), status: DONE }];
    later(200_000);
    await sync.check();
    expect(store.view().closed.map((t) => t.doneHere)).toEqual([true]);
    expect(store.view().tickets).toEqual([]);

    sources[0]!.state.listed = [];
    sources[0]!.state.statuses.set('A-1', DONE);
    later(200_000);
    await sync.check();
    expect(store.view().closed.map((t) => [t.ref, t.doneHere, t.closedAt])).toEqual([['A-1', true, NOW + 10]]);
  });

  it('goes back to the waiting list when the move is undone', async () => {
    const { store, sync, sources } = setup();
    sources[0]!.state.listed = [ticket('A-1')];
    await sync.check();
    store.setStatus('jira:A-1', DONE, NOW + 10);

    store.setStatus('jira:A-1', TODO, NOW + 20);

    expect(store.view().closed).toEqual([]);
    expect(store.view().tickets.map((t) => t.ref)).toEqual(['A-1']);
  });

  it('is an ordinary ticket again when its tracker lists it reopened', async () => {
    const { store, sync, sources, later } = setup();
    sources[0]!.state.listed = [ticket('A-1')];
    await sync.check();
    store.setStatus('jira:A-1', DONE, NOW - 10_000);

    later(200_000);
    await sync.check();

    expect(store.view().closed).toEqual([]);
    expect(store.view().tickets.map((t) => t.ref)).toEqual(['A-1']);
  });

  it('keeps the mark across a restart', () => {
    const saved = asClosedTickets(JSON.parse(JSON.stringify([{ ...ticket('A-1'), status: DONE, closedAt: NOW, doneHere: true }])));
    expect(saved.map((t) => t.doneHere)).toEqual([true]);
  });
});

describe('a ticket the user closed here without completing it (GitHub’s Close, not planned)', () => {
  // Matt, 2026-11-23: "Things that are closed should land in the closed list, not done … Done should mean that the work was completed."
  const NOT_PLANNED: TicketMove = { name: 'Closed', category: 'done', label: 'Close', notCompleted: true };

  it('is in Closed at once, not Done, while its tracker still lists it', async () => {
    const { store, sync, sources } = setup();
    sources[0]!.state.listed = [ticket('A-1'), ticket('A-2')];
    await sync.check();

    store.setStatus('jira:A-1', NOT_PLANNED, NOW + 10);

    const view = store.view();
    expect(view.tickets.map((t) => t.ref)).toEqual(['A-2']);
    expect(doneHere(view.closed)).toEqual([]);
    expect(closedElsewhere(view.closed).map((t) => [t.ref, t.closedHere, t.doneHere, t.closedAt])).toEqual([['A-1', true, undefined, NOW + 10]]);
  });

  it('a Done move lands in Done; moving a closed one to Done moves it from Closed to Done, and back again', async () => {
    const { store, sync, sources } = setup();
    sources[0]!.state.listed = [ticket('A-1'), ticket('A-2')];
    await sync.check();

    store.setStatus('jira:A-2', DONE, NOW + 5);
    store.setStatus('jira:A-1', NOT_PLANNED, NOW + 10);
    expect(doneHere(store.view().closed).map((t) => t.ref)).toEqual(['A-2']);
    expect(closedElsewhere(store.view().closed).map((t) => t.ref)).toEqual(['A-1']);

    store.setStatus('jira:A-1', DONE, NOW + 20);
    expect(doneHere(store.view().closed).map((t) => [t.ref, t.doneHere, t.closedHere, t.closedAt])).toEqual([['A-1', true, undefined, NOW + 10], ['A-2', true, undefined, NOW + 5]]);
    expect(closedElsewhere(store.view().closed)).toEqual([]);

    store.setStatus('jira:A-1', NOT_PLANNED, NOW + 30);
    expect(closedElsewhere(store.view().closed).map((t) => t.ref)).toEqual(['A-1']);
  });

  it('stays in Closed when it leaves the list and is found closed, and across a restart', async () => {
    const { store, sync, sources, later } = setup();
    sources[0]!.state.listed = [ticket('A-1')];
    await sync.check();
    store.setStatus('jira:A-1', NOT_PLANNED, NOW + 10);

    sources[0]!.state.listed = [];
    sources[0]!.state.statuses.set('A-1', NOT_PLANNED);
    later(200_000);
    await sync.check();
    expect(store.view().closed.map((t) => [t.ref, t.closedHere, t.closedAt])).toEqual([['A-1', true, NOW + 10]]);
    expect(asClosedTickets(JSON.parse(JSON.stringify(store.view().closed))).map((t) => t.closedHere)).toEqual([true]);
  });

  it('goes back to the waiting list when the move is undone', async () => {
    const { store, sync, sources } = setup();
    sources[0]!.state.listed = [ticket('A-1')];
    await sync.check();
    store.setStatus('jira:A-1', NOT_PLANNED, NOW + 10);
    store.setStatus('jira:A-1', { name: 'Open', category: 'todo' }, NOW + 20);
    expect(store.view().closed).toEqual([]);
    expect(store.view().tickets.map((t) => t.ref)).toEqual(['A-1']);
  });

  it('is told apart by one function: completed work is Done, anything else closed is Closed', () => {
    expect(marksDone(DONE)).toBe(true);
    expect(marksDone(NOT_PLANNED)).toBe(false);
    expect(closedHereMark(DONE)).toEqual({ doneHere: true });
    expect(closedHereMark(NOT_PLANNED)).toEqual({ closedHere: true });
  });
});
