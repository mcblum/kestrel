// A comment the user types on a ticket's page (comment.ts): one function, the tracker scripted.
import { describe, expect, it } from 'vitest';
import { Refused } from '../refused.ts';
import { ready, unavailable } from '../shared/sourced.ts';
import { TICKETS_OFF_REASON, type Ticket } from '../shared/tickets.ts';
import { ticketsRoute } from './api.ts';
import { commentOnTicket, TICKET_COMMENT_LIMIT } from './comment.ts';
import type { TicketSource } from './source.ts';
import { TicketStore } from './store.ts';

const ON = { settings: { on: true, off: [], show: 'page' as const } };
const TICKET: Ticket = { key: 'jira:A-1', source: 'jira', tracker: 'Jira', ref: 'A-1', title: 'A', status: { name: 'To Do', category: 'todo' }, project: 'P', url: '', openedAt: 1, updatedAt: 1, sprint: null };

function setup(fail?: string) {
  const store = new TicketStore(ON);
  store.set('jira', ready([TICKET]));
  const sent: string[] = [];
  const read: string[] = [];
  const source: TicketSource = {
    kind: 'jira',
    name: 'Jira',
    assignedToMe: async () => ready([TICKET]),
    status: async () => unavailable('no'),
    read: async () => unavailable('no'),
    statuses: async () => ready([]),
    move: async () => Promise.reject(new Error('no')),
    comment: async (_t, body) => {
      if (fail) throw new Error(fail);
      sent.push(body);
    },
  };
  const deps = { store, sourceOf: async () => source as TicketSource | null, read: async (key: string) => void read.push(key) };
  return { store, deps, sent, read };
}

describe('commenting on a ticket', () => {
  it('sends the trimmed comment to the tracker and reads the ticket again', async () => {
    const { deps, sent, read } = setup();
    await expect(commentOnTicket(deps, 'jira:A-1', '  Looks done.  ')).resolves.toEqual({ key: 'jira:A-1', ref: 'A-1' });
    expect(sent).toEqual(['Looks done.']);
    expect(read).toEqual(['jira:A-1']);
  });

  it('refuses an empty comment, one too long, and a ticket it does not hold, sending nothing', async () => {
    const { deps, sent } = setup();
    await expect(commentOnTicket(deps, 'jira:A-1', '   ')).rejects.toThrow('Write the comment first.');
    await expect(commentOnTicket(deps, 'jira:A-1', 'x'.repeat(TICKET_COMMENT_LIMIT + 1))).rejects.toBeInstanceOf(Refused);
    await expect(commentOnTicket(deps, 'jira:NOPE', 'hello')).rejects.toThrow('Kestrel does not hold that ticket.');
    expect(sent).toEqual([]);
  });

  it('gives the tracker’s own reason when it refuses, and does not read again', async () => {
    const { deps, read } = setup('Jira says no');
    await expect(commentOnTicket(deps, 'jira:A-1', 'hello')).rejects.toThrow('Jira says no');
    expect(read).toEqual([]);
  });

  it('refuses while tickets are off or the tracker is not connected', async () => {
    const { deps, store } = setup();
    await expect(commentOnTicket({ ...deps, sourceOf: async () => null }, 'jira:A-1', 'hello')).rejects.toThrow('not connected');
    store.setSettings({ on: false, off: [], show: 'page' });
    await expect(commentOnTicket(deps, 'jira:A-1', 'hello')).rejects.toThrow(TICKETS_OFF_REASON);
  });

  it('is reached by the comment route', async () => {
    const { deps, store, sent } = setup();
    const sync = { sourceOf: deps.sourceOf, read: deps.read } as never;
    const answer = await ticketsRoute(['api', 'tickets', 'comment'], 'POST', new URL('http://x/'), async () => ({ key: 'jira:A-1', body: 'From the page' }), { store, sync, work: {} as never });
    expect(answer?.status).toBe(201);
    expect(sent).toEqual(['From the page']);
    const bad = await ticketsRoute(['api', 'tickets', 'comment'], 'POST', new URL('http://x/'), async () => ({ key: 'jira:A-1' }), { store, sync, work: {} as never });
    expect(bad?.status).toBe(400);
  });
});
