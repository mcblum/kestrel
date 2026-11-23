// What an independent review of the tickets feature found, each pinned by a test: two quick clicks,
// a round running while sources change, a move undone by an answer already on its way, a check that
// must never reject, a GitLab host with a port, labels that say the opposite of their word, a session
// that already has a ticket, details of tickets no longer held, and tracker text marked as data.
import { describe, expect, it, vi } from 'vitest';
import type { Project, Session } from '../model.ts';
import { Refused } from '../refused.ts';
import type { StartRequest } from '../runtime/bring-up.ts';
import { ready, unavailable } from '../shared/sourced.ts';
import type { Ticket } from '../shared/tickets.ts';
import { ticketBrief, UNTRUSTED_NOTE } from './brief.ts';
import { BRIEF_WAIT_MS, sessionTickets } from './session.ts';
import type { TicketSource } from './source.ts';
import { fakeTicketSource, sampleDetail, sampleTickets } from './sources/fake.ts';
import { issueOfKey, labelStatus } from './sources/gitlab.ts';
import { TicketStore } from './store.ts';
import { syncTickets } from './sync.ts';
import { workTicket } from './work.ts';
import { ticketsRoute } from './api.ts';

const ON = { settings: { on: true, off: [], show: 'page' as const } };
const NOW = Date.parse('2026-11-22T12:00:00Z');

const sourceOf = (kind: string, list: () => Promise<Ticket[]>): TicketSource => ({
  kind,
  name: kind,
  assignedToMe: async () => ready(await list()),
  read: async () => ready({ description: '', criteria: [], comments: [] }),
  status: async () => unavailable('no'),
  statuses: async () => ready([]),
  move: async () => Promise.reject(new Error('no')),
  comment: async () => Promise.reject(new Error('no')),
});

describe('Work this ticket, clicked twice quickly', () => {
  it('starts one lead and gives both clicks that session', async () => {
    const store = new TicketStore(ON);
    const source = fakeTicketSource(() => NOW);
    store.set('fake', await source.assignedToMe());
    const sessions: Session[] = [];
    let starts = 0;
    const deps = {
      store,
      projects: async () => [] as Project[],
      sessions: async () => sessions,
      originOf: async () => null,
      read: async () => new Promise<void>((r) => setTimeout(r, 10)),
      start: async (req: StartRequest) => {
        starts++;
        const s = { id: `s${starts}`, title: req.title } as Session;
        sessions.push(s);
        return s;
      },
      tag: async () => undefined,
    };
    const [a, b] = await Promise.all([workTicket(deps, 'fake:BELL-139', { agent: 'claude' }), workTicket(deps, 'fake:BELL-139', { agent: 'claude' })]);
    expect(a.id).toBe(b.id);
    expect(starts).toBe(1);
    expect(store.view().links).toHaveLength(1);
  });
});

describe('the sync', () => {
  it('asks a source connected while a round runs as soon as that round ends', async () => {
    const store = new TicketStore(ON);
    let release: () => void = () => undefined;
    const slow = sourceOf('gitlab', () => new Promise((r) => (release = () => r([]))));
    const jira = sourceOf('jira', async () => [{ ...sampleTickets(NOW)[0]!, key: 'jira:x/OPS-1', source: 'jira', ref: 'OPS-1' }]);
    let list: TicketSource[] = [slow];
    const sync = syncTickets(async () => list, store, () => true, () => NOW, false);
    const first = sync.check();
    await new Promise((r) => setTimeout(r, 0));
    list = [slow, jira];
    const second = sync.check();
    release();
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await vi.waitFor(() => expect(store.view().tickets.map((t) => t.ref)).toEqual(['OPS-1']));
  });

  it('never rejects a check, even when listing the sources fails', async () => {
    const store = new TicketStore(ON);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sync = syncTickets(async () => Promise.reject(new Error('glab gone')), store, () => true, () => NOW, false);
    await expect(sync.check()).resolves.toBeUndefined();
    error.mockRestore();
  });

  it('keeps a move the user just made when an answer asked before it arrives, and takes the tracker’s word after', () => {
    const store = new TicketStore(ON);
    const t = { ...sampleTickets(NOW)[0]! };
    store.set('fake', ready([t]), 1);
    store.setStatus(t.key, { name: 'In Progress', category: 'in-progress' }, 100);
    store.set('fake', ready([t]), 50); // asked before the move
    expect(store.ticket(t.key)!.status.name).toBe('In Progress');
    store.set('fake', ready([{ ...t, status: { name: 'Done', category: 'done' } }]), 200); // asked after
    expect(store.ticket(t.key)!.status.name).toBe('Done');
  });

  it('drops the details of tickets no longer held, and the read route refuses a key it does not hold', async () => {
    const store = new TicketStore(ON);
    const t = sampleTickets(NOW)[0]!;
    store.set('fake', ready([t]));
    store.setDetail(t.key, ready(sampleDetail(t.ref, NOW)!));
    store.set('fake', ready([]));
    store.forgetDetails();
    expect(store.view().details).toEqual({});
    const sync = syncTickets(async () => [], store, () => true, () => NOW, false);
    const answer = await ticketsRoute(['api', 'tickets', 'read'], 'POST', new URL('http://x/'), async () => ({ key: 'fake:NOPE-1' }), { store, sync, work: {} as never });
    expect(answer?.status).toBe(404);
    expect(store.view().details).toEqual({});
  });
});

describe('GitLab keys and labels', () => {
  it('finds the issue of a host with a port', () => {
    expect(issueOfKey('gitlab@gitlab.corp:8443:group/sub/app#4')).toEqual({ host: 'gitlab.corp:8443', path: 'group/sub/app', iid: 4 });
    expect(issueOfKey('gitlab@gitlab.com:group/app#4')).toEqual({ host: 'gitlab.com', path: 'group/app', iid: 4 });
  });

  it('does not read “Not started” as started or “No review needed” as in review', () => {
    expect(labelStatus(['workflow::Not started']).category).toBe('todo');
    expect(labelStatus(['Unstarted']).category).toBe('todo');
    expect(labelStatus(['No review needed']).category).toBe('todo');
    expect(labelStatus(['workflow::In review']).category).toBe('in-review');
    expect(labelStatus(['Doing']).category).toBe('in-progress');
  });
});

describe('a session’s ticket', () => {
  const setup = async (read: () => Promise<void> = async () => undefined) => {
    const store = new TicketStore(ON);
    store.set('fake', ready(sampleTickets(NOW)));
    const tags: string[] = [];
    const tickets = sessionTickets({ store, sync: { read, sourceOf: async () => null }, workstreams: async () => [], liveSessions: async () => new Set(['me']), tag: async (_id, t) => tags.push(t), untag: async () => undefined });
    return { store, tickets, tags };
  };

  it('keeps the ticket it has: attaching another is refused with the reason', async () => {
    const { tickets, store } = await setup();
    await tickets.attach('me', 'fake:BELL-139');
    await expect(tickets.attach('me', 'fake:DOCS-77')).rejects.toThrow(Refused);
    await expect(tickets.attach('me', 'fake:DOCS-77')).rejects.toThrow('already works on BELL-139');
    expect(store.view().links.map((l) => l.ticketKey)).toEqual(['fake:BELL-139']);
  });

  it('gives the brief without the description when the tracker is slow, so the user’s message is not held up', async () => {
    vi.useFakeTimers();
    try {
      const { tickets } = await setup(() => new Promise(() => undefined));
      const brief = tickets.brief('fake:BELL-139');
      await vi.advanceTimersByTimeAsync(BRIEF_WAIT_MS);
      expect(await brief).toContain('could not be read');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the tracker’s text as data, before the description and comments', () => {
    const t = sampleTickets(NOW).find((x) => x.ref === 'BELL-142')!;
    const brief = ticketBrief(t, sampleDetail('BELL-142', NOW));
    expect(brief.indexOf(UNTRUSTED_NOTE)).toBeGreaterThan(0);
    expect(brief.indexOf(UNTRUSTED_NOTE)).toBeLessThan(brief.indexOf('## Description'));
  });
});
