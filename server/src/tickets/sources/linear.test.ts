// Linear issues as tickets: recorded answers in the shape of Linear's published GraphQL schema; never
// the network.
import { describe, expect, it } from 'vitest';
import { memoryCredentials } from '../credentials.ts';
import { LinearConnection } from '../linear-connection.ts';
import { ASSIGNED_QUERY, COMMENT_MUTATION, linearCategory, linearSprint, linearTicketSource, MOVE_MUTATION, STATES_QUERY, STATUS_QUERY, type LinearFetch } from './linear.ts';
import type { Ticket } from '../../shared/tickets.ts';

const ISSUE = {
  id: 'uuid-1',
  identifier: 'ENG-42',
  title: 'Paginate the audit log',
  url: 'https://linear.app/acme/issue/ENG-42/paginate-the-audit-log',
  priority: 2,
  priorityLabel: 'High',
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-22T08:00:00.000Z',
  state: { id: 's-started', name: 'In Progress', type: 'started' },
  team: { id: 't1', key: 'ENG', name: 'Engineering' },
  cycle: { name: null, number: 31, isActive: true },
  assignee: { name: 'sam', displayName: 'Sam' },
};

const STATES = {
  issue: {
    state: { id: 's-started', name: 'In Progress', type: 'started' },
    team: {
      states: {
        nodes: [
          { id: 's-done', name: 'Done', type: 'completed', position: 4 },
          { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
          { id: 's-started', name: 'In Progress', type: 'started', position: 2 },
          { id: 's-review', name: 'In Review', type: 'started', position: 3 },
        ],
      },
    },
  },
};

interface Call {
  query: string;
  variables: Record<string, unknown>;
  auth: string;
}

function recorded(answer: (call: Call) => unknown, status = 200): { fetcher: LinearFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: LinearFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const call = { ...body, auth: init.headers.Authorization! };
    calls.push(call);
    return { status, ok: status < 400, json: async () => answer(call) };
  };
  return { fetcher, calls };
}

describe('Linear issues as tickets', () => {
  it('maps state types to categories, a started state named for review being in review', () => {
    expect(linearCategory('backlog', 'Backlog')).toBe('todo');
    expect(linearCategory('triage', 'Triage')).toBe('todo');
    expect(linearCategory('unstarted', 'Todo')).toBe('todo');
    expect(linearCategory('started', 'In Progress')).toBe('in-progress');
    expect(linearCategory('started', 'In Review')).toBe('in-review');
    expect(linearCategory('completed', 'Done')).toBe('done');
    expect(linearCategory('canceled', 'Canceled')).toBe('done');
  });

  it('takes a cycle as the sprint, the active one being current', () => {
    expect(linearSprint({ name: null, number: 31, isActive: true })).toEqual({ name: 'Cycle 31', current: true });
    expect(linearSprint({ name: 'Polish', number: 32, isActive: false })).toEqual({ name: 'Polish', current: false });
    expect(linearSprint(null)).toBeNull();
  });

  it('lists the open issues assigned to the viewer, with the key sent as it is', async () => {
    const { fetcher, calls } = recorded(() => ({ data: { viewer: { assignedIssues: { nodes: [ISSUE, { title: 'no identifier' }] } } } }));
    const list = await linearTicketSource('lin_api_test', fetcher).assignedToMe();
    expect(calls[0]).toMatchObject({ query: ASSIGNED_QUERY, auth: 'lin_api_test', variables: { finished: ['completed', 'canceled', 'duplicate'] } });
    expect(list).toEqual({
      state: 'ready',
      value: [
        {
          key: 'linear:ENG-42',
          source: 'linear',
          tracker: 'Linear',
          ref: 'ENG-42',
          title: 'Paginate the audit log',
          status: { name: 'In Progress', category: 'in-progress' },
          project: 'Engineering',
          url: ISSUE.url,
          openedAt: Date.parse(ISSUE.createdAt),
          updatedAt: Date.parse(ISSUE.updatedAt),
          priority: 2,
          priorityName: 'High',
          assignee: 'Sam',
          sprint: { name: 'Cycle 31', current: true },
          projectKey: 'ENG',
        },
      ],
    });
  });

  it('reads an issue’s description and comments oldest first', async () => {
    const { fetcher } = recorded(() => ({ data: { issue: { description: 'Slow.\n\n## Acceptance criteria\n- 50 per page', comments: { nodes: [{ body: 'Later', createdAt: '2026-11-21T00:00:00Z', user: null }, { body: 'First', createdAt: '2026-11-20T00:00:00Z', user: { name: 'kim', displayName: 'Kim' } }] } } } }));
    const source = linearTicketSource('k', fetcher);
    const detail = await source.read({ ref: 'ENG-42', key: 'linear:ENG-42' } as never);
    expect(detail).toEqual({ state: 'ready', value: { description: 'Slow.\n\n## Acceptance criteria\n- 50 per page', criteria: ['50 per page'], comments: [{ author: 'Kim', at: Date.parse('2026-11-20T00:00:00Z'), body: 'First' }, { author: '', at: Date.parse('2026-11-21T00:00:00Z'), body: 'Later' }] } });
  });

  it('offers the team’s other states in order, and moves by state id', async () => {
    const { fetcher, calls } = recorded((call) => (call.query === STATES_QUERY ? { data: STATES } : { data: { issueUpdate: { success: true, issue: { state: { id: 's-review', name: 'In Review', type: 'started' } } } } }));
    const source = linearTicketSource('k', fetcher);
    const ticket = { ref: 'ENG-42', key: 'linear:ENG-42', status: { name: 'In Progress', category: 'in-progress' } } as never;
    expect(await source.statuses(ticket)).toEqual({ state: 'ready', value: [{ name: 'Todo', category: 'todo' }, { name: 'In Review', category: 'in-review' }, { name: 'Done', category: 'done' }] });
    expect(await source.move(ticket, 'In Review')).toEqual({ name: 'In Review', category: 'in-review' });
    expect(calls.at(-1)).toMatchObject({ query: MOVE_MUTATION, variables: { id: 'ENG-42', stateId: 's-review' } });
    await expect(source.move(ticket, 'Shipped')).rejects.toThrow('no state “Shipped”');
  });

  it('adds a comment by the issue’s identifier, and says so when Linear does not', async () => {
    const { fetcher, calls } = recorded(() => ({ data: { commentCreate: { success: true } } }));
    await linearTicketSource('k', fetcher).comment({ ref: 'ENG-42' } as never, 'Started on this.');
    expect(calls.at(-1)).toMatchObject({ query: COMMENT_MUTATION, variables: { issueId: 'ENG-42', body: 'Started on this.' } });
    const failing = recorded(() => ({ data: { commentCreate: { success: false } } }));
    await expect(linearTicketSource('k', failing.fetcher).comment({ ref: 'ENG-42' } as never, 'x')).rejects.toThrow('did not add the comment');
  });

  it('says Linear’s own reason when it refuses', async () => {
    const { fetcher } = recorded(() => ({ errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), 400);
    expect(await linearTicketSource('bad', fetcher).assignedToMe()).toEqual({ state: 'unavailable', reason: expect.stringContaining('did not accept the API key') });
    const other = recorded(() => ({ errors: [{ message: 'Entity not found: Issue' }] }));
    await expect(linearTicketSource('k', other.fetcher).move({ ref: 'ENG-9' } as never, 'Done')).rejects.toThrow('Linear said: Entity not found: Issue');
  });
});

describe('Connecting Linear', () => {
  it('asks Linear who the key is before keeping it, keeps Jira beside it, and never shows the key', async () => {
    const store = memoryCredentials({ jira: { site: 'acme.atlassian.net', email: 'a@b.co', token: 't' }, linear: null });
    const { fetcher } = recorded(() => ({ data: { viewer: { name: 'sam', displayName: 'Sam', email: 's@acme.test' } } }));
    const linear = new LinearConnection(store, { fetcher });
    await expect(linear.connect({ key: ' ' })).rejects.toThrow('Paste a personal API key');
    const view = await linear.connect({ key: 'lin_api_test' });
    expect(view).toEqual({ connected: true, name: 'Sam', storage: 'keystore', unavailable: null });
    expect(JSON.stringify(view)).not.toContain('lin_api_test');
    expect((await store.read()).jira?.site).toBe('acme.atlassian.net');
    expect(await linear.ticketSource()).not.toBeNull();
    await linear.disconnect();
    expect(await store.read()).toEqual({ jira: { site: 'acme.atlassian.net', email: 'a@b.co', token: 't' }, linear: null });
  });

  it('refuses a key Linear does not accept, keeping nothing', async () => {
    const store = memoryCredentials();
    const { fetcher } = recorded(() => ({ errors: [{ message: 'not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), 401);
    await expect(new LinearConnection(store, { fetcher }).connect({ key: 'nope' })).rejects.toThrow('did not accept the API key');
    expect((await store.read()).linear).toBeNull();
  });
});

describe('one Linear issue’s state, for a ticket that left the list', () => {
  it('asks for that issue’s state: completed or canceled is done, started is not; an error decides nothing', async () => {
    const states: Record<string, unknown> = { 'ENG-1': { name: 'Done', type: 'completed' }, 'ENG-2': { name: 'Canceled', type: 'canceled' }, 'ENG-3': { name: 'In Progress', type: 'started' } };
    const { fetcher, calls } = recorded((call) => (states[String(call.variables.id)] ? { data: { issue: { state: states[String(call.variables.id)] } } } : { errors: [{ message: 'Entity not found' }] }));
    const source = linearTicketSource('lin_api_test', fetcher);
    expect(await source.status({ ref: 'ENG-1' } as Ticket)).toEqual({ state: 'ready', value: { name: 'Done', category: 'done' } });
    expect(calls[0]).toMatchObject({ query: STATUS_QUERY, variables: { id: 'ENG-1' } });
    expect(await source.status({ ref: 'ENG-2' } as Ticket)).toEqual({ state: 'ready', value: { name: 'Canceled', category: 'done' } });
    expect(await source.status({ ref: 'ENG-3' } as Ticket)).toEqual({ state: 'ready', value: { name: 'In Progress', category: 'in-progress' } });
    const missing = await source.status({ ref: 'ENG-4' } as Ticket);
    expect(missing.state === 'unavailable' && missing.reason).toBe('Linear said: Entity not found');
  });
});
