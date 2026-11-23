// Work this ticket (docs/designs/tickets.md, section 6): the brief, matching a ticket to a project,
// and starting its lead. The tracker is the scripted one and the runtime a stand-in.
import { describe, expect, it } from 'vitest';
import type { Project, Session } from '../model.ts';
import { Refused } from '../refused.ts';
import type { StartRequest } from '../runtime/bring-up.ts';
import { ready } from '../shared/sourced.ts';
import { asTicketMatches, asTicketSettings, matchedProjectId, orderTickets } from '../shared/tickets.ts';
import { ticketBrief, TICKET_BRIEF } from './brief.ts';
import { fakeTicketSource, sampleDetail, sampleTickets } from './sources/fake.ts';
import { TicketStore } from './store.ts';
import { matchProject, projectForTicket, workTicket } from './work.ts';

/** Tickets turned on in Settings → Tickets, as the tests of a working list need. */
const ON = { settings: { on: true, off: [], show: 'page' as const } };

const NOW = Date.parse('2026-11-22T12:00:00Z');

describe('ticketBrief', () => {
  it('is the ticket, its description and comments, then the standing brief', () => {
    const [t] = sampleTickets(NOW).filter((x) => x.ref === 'BELL-142');
    const brief = ticketBrief(t!, sampleDetail('BELL-142', NOW));
    expect(brief.startsWith('# BELL-142: Cart total jumps')).toBe(true);
    expect(brief).toContain('Sprint: Sprint 24');
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('**priya**');
    expect(brief.endsWith(TICKET_BRIEF)).toBe(true);
    expect(ticketBrief(t!, null)).toContain('could not be read');
  });
});

const project = (id: string, name: string, path = `/work/${id}`): Project => ({ id, name, folders: [{ id: `${id}-f`, path, isGit: true }] }) as unknown as Project;

describe('matchProject', () => {
  const projects = [project('bellbird', 'Bellbird'), project('platform-api', 'Platform API', '/work/api')];
  it('matches by the repository’s remote first, then by the tracker project’s name', () => {
    const origins = new Map([['/work/api', 'git@gitlab.example.com:shop/api.git']]);
    expect(matchProject({ project: 'shop/api', repository: { hostName: 'gitlab.example.com', path: 'shop/api' } }, projects, origins)?.id).toBe('platform-api');
    expect(matchProject({ project: 'Platform API' }, projects, new Map())?.id).toBe('platform-api');
    expect(matchProject({ project: 'bellbird' }, projects, new Map())?.id).toBe('bellbird');
    expect(matchProject({ project: 'Elsewhere' }, projects, new Map())).toBeNull();
  });

  it('starts in the project the user matched the tracker project or team to, before any other match', () => {
    const origins = new Map([['/work/api', 'git@gitlab.example.com:shop/api.git']]);
    const matches = { bellbird: ['ENG', 'Shop API'] };
    expect(matchProject({ project: 'Elsewhere', projectKey: 'eng' }, projects, new Map(), matches)?.id).toBe('bellbird');
    expect(matchProject({ project: 'shop/api', repository: { hostName: 'gitlab.example.com', path: 'shop/api' } }, projects, origins, { bellbird: ['shop/api'] })?.id).toBe('bellbird');
    // A match to a project that is gone is passed over.
    expect(matchProject({ project: 'Platform API' }, projects, new Map(), { removed: ['Platform API'] })?.id).toBe('platform-api');
  });
});

describe('Settings → Tickets → Projects', () => {
  it('keeps typed matches tidy: trimmed, no blanks or repeats, a project with none left out', () => {
    expect(asTicketMatches({ a: [' PLAT ', '', 'PLAT', 3], b: [], c: 'x' })).toEqual({ a: ['PLAT'] });
    expect(asTicketMatches(['a'])).toEqual({});
    expect(asTicketSettings({ on: true, off: [], show: 'page', matches: { b: [] } })).toEqual({ on: true, off: [], show: 'page' });
    expect(matchedProjectId({ project: 'Platform API' }, { p: ['platform-api'] })).toBe('p');
    expect(matchedProjectId({ project: 'Other' }, undefined)).toBeNull();
  });

  it('is saved through the settings route, replacing what was, and used by Work this ticket', async () => {
    const { ticketsRoute } = await import('./api.ts');
    const store = new TicketStore(ON);
    store.set('fake', ready(sampleTickets(NOW)));
    const projects = [project('bellbird', 'Bellbird'), project('checkout', 'Checkout service')];
    const work = { projects: async () => projects, originOf: async () => null };
    const api = { store, sync: { check: async () => undefined } as never, work: work as never };
    const put = (body: unknown) => ticketsRoute(['api', 'tickets', 'settings'], 'PUT', new URL('http://x/'), async () => body as Record<string, unknown>, api);
    const bell = sampleTickets(NOW).find((t) => t.ref === 'BELL-142')!;
    expect((await put({ matches: { checkout: ['Bellbird'] } }))?.body).toMatchObject({ matches: { checkout: ['Bellbird'] } });
    expect((await projectForTicket({ ...work, store }, bell))?.id).toBe('checkout');
    expect((await put({ matches: {} }))?.body).not.toHaveProperty('matches');
    expect((await projectForTicket({ ...work, store }, bell))?.id).toBe('bellbird');
    expect((await put({ matches: ['x'] }))?.status).toBe(400);
  });
});

describe('workTicket', () => {
  const setup = () => {
    const store = new TicketStore(ON);
    store.set('fake', ready(sampleTickets(NOW)));
    const sessions: Session[] = [];
    const started: StartRequest[] = [];
    const tags: [string, string][] = [];
    const proposed: string[] = [];
    const source = fakeTicketSource(() => NOW);
    const deps = {
      store,
      projects: async () => [project('bellbird', 'Bellbird'), project('platform', 'Platform')],
      sessions: async () => sessions,
      originOf: async () => null,
      read: async (key: string) => store.setDetail(key, await source.read(store.ticket(key)!)),
      start: async (req: StartRequest) => {
        started.push(req);
        const s = { id: `s${sessions.length + 1}`, title: req.title } as Session;
        sessions.push(s);
        return s;
      },
      tag: async (id: string, tag: string) => tags.push([id, tag]),
      started: (id: string) => proposed.push(id),
      now: () => NOW,
    };
    return { store, deps, started, tags, proposed };
  };

  it('starts a lead in the matched project with the brief, attaches the ticket and tags the session', async () => {
    const { store, deps, started, tags, proposed } = setup();
    const session = await workTicket(deps, 'fake:BELL-142', { agent: 'claude', permission: 'auto' });
    expect(started[0]).toMatchObject({ agent: 'claude', projectId: 'bellbird', permission: 'auto', title: 'BELL-142: Cart total jumps while quantities are still changing' });
    expect(started[0]!.prompt).toContain('Support has had four tickets');
    expect(store.view().links).toEqual([{ ticketKey: 'fake:BELL-142', attachedTo: 'session', id: session.id, role: 'lead', at: NOW }]);
    expect(tags).toEqual([[session.id, 'BELL-142']]);
    expect(proposed).toEqual([session.id]); // Kestrel proposes In progress
    // A second click opens the same lead, and proposes nothing again.
    expect((await workTicket(deps, 'fake:BELL-142', { agent: 'claude' })).id).toBe(session.id);
    expect(started).toHaveLength(1);
    expect(proposed).toHaveLength(1);
  });

  it('opens the lead of the workstream a ticket is attached to, rather than starting another', async () => {
    const { store, deps, started } = setup();
    const lead = await deps.start({ agent: 'claude', projectId: null, prompt: 'x', title: 'Checkout' } as StartRequest);
    started.length = 0;
    store.attach({ ticketKey: 'fake:PLAT-318', attachedTo: 'workstream', id: 'w1', role: 'lead', at: NOW });
    const withStreams = { ...deps, workstreams: async () => [{ id: 'w1', sessionIds: [lead.id] }] };
    expect((await workTicket(withStreams, 'fake:PLAT-318', { agent: 'claude' })).id).toBe(lead.id);
    expect(started).toEqual([]);
  });

  it('starts with no project when asked to, and refuses a ticket no longer held', async () => {
    const { deps, started } = setup();
    await workTicket(deps, 'fake:PLAT-318', { agent: 'codex', projectId: null });
    expect(started[0]!.projectId).toBeNull();
    await expect(workTicket(deps, 'fake:NOPE-1', { agent: 'claude' })).rejects.toBeInstanceOf(Refused);
  });

  it('orders the sample sprint first', () => {
    expect(orderTickets(sampleTickets(NOW)).map((t) => t.ref)).toEqual(['BELL-142', 'PLAT-318', 'BELL-139', 'DOCS-77', 'PLAT-301', 'BELL-120']);
  });
});

describe('ticket routes', () => {
  it('round-trips the Tickets page and a ticket’s page through their paths', async () => {
    const { parseViewPath, viewPath, containerOf } = await import('../shared/routes.ts');
    for (const view of [{ kind: 'tickets' as const }, { kind: 'tickets' as const, filter: 'dismissed' as const }, { kind: 'ticket' as const, id: 'gitlab@gitlab.example.com:shop/web#27' }]) expect(parseViewPath(viewPath(view))).toEqual(view);
    expect(containerOf({ kind: 'tickets', filter: 'dismissed' })).toEqual({ kind: 'tickets' });
  });
});
