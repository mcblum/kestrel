// The Tickets routes (docs/designs/tickets.md): dismiss and mark read, ask for a ticket's detail, the
// project a ticket's work would start in, and Work this ticket. The list itself is never asked for:
// the server pushes it (`tickets` over the socket).
import type { Session } from '../model.ts';
import { Refused } from '../refused.ts';
import { AGENT_LABEL, type Agent } from '../model.ts';
import { isPermissionLevel } from '../shared/permissions.ts';
import { asDismissedKeys } from '../shared/review-requests.ts';
import { isReviewPlace } from '../shared/review-settings.ts';
import { asTicketSettings, TICKETS_OFF_REASON, ticketsOn, type TicketSourceStatus } from '../shared/tickets.ts';
import type { TicketStore } from './store.ts';
import type { TicketSync } from './sync.ts';
import type { JiraConnection } from './jira-connection.ts';
import type { LinearConnection } from './linear-connection.ts';
import { commentOnTicket } from './comment.ts';
import { moveTicket } from './move.ts';
import { projectForTicket, workTicket, type WorkTicketDeps } from './work.ts';

export interface TicketsApi {
  store: TicketStore;
  /** Connecting Jira Cloud (Settings → Tickets). */
  jira?: JiraConnection;
  /** Connecting Linear (Settings → Tickets). */
  linear?: LinearConnection;
  sync: TicketSync;
  /** How each tracker stands, for Settings → Tickets. */
  sources?: () => Promise<TicketSourceStatus[]>;
  work: Omit<WorkTicketDeps, 'store' | 'read'>;
}

type Answer = { status: number; body: unknown } | null;
type Body = Record<string, unknown>;

const keysOf = (raw: unknown): string[] | null => (Array.isArray(raw) && raw.every((k) => typeof k === 'string') ? asDismissedKeys(raw) : null);
const opt = (raw: unknown): string | undefined => (typeof raw === 'string' && raw ? raw : undefined);

export async function ticketsRoute(parts: readonly string[], method: string, url: URL, readBody: () => Promise<Body>, api: TicketsApi | undefined): Promise<Answer> {
  if (parts[1] !== 'tickets') return null;
  if (!api) return { status: 409, body: { error: 'Tickets are not available in this copy of Kestrel.' } };
  const { store, sync } = api;
  const what = parts[2];
  if (what === 'linear' && parts.length === 3 && api.linear) {
    if (method === 'GET') return { status: 200, body: await api.linear.view() };
    if (method === 'PUT') return { status: 200, body: await api.linear.connect({ key: (await readBody()).key }) };
    if (method === 'DELETE') return { status: 200, body: await api.linear.disconnect() };
  }
  if (what === 'jira' && parts.length === 3 && api.jira) {
    if (method === 'GET') return { status: 200, body: await api.jira.view() };
    if (method === 'PUT') {
      const body = await readBody();
      return { status: 200, body: await api.jira.connect({ site: body.site, email: body.email, token: body.token }) };
    }
    if (method === 'DELETE') return { status: 200, body: await api.jira.disconnect() };
  }
  // Settings → Tickets: on or off, the sources switched off, where tickets appear, and the tracker projects matched to Kestrel projects (all of them, replacing what was). The view pushed to every window carries
  // them, so there is no GET. What is not given stays as it is.
  if (what === 'settings' && method === 'PUT') {
    const body = await readBody();
    const given = body.on !== undefined || body.off !== undefined || body.show !== undefined || body.matches !== undefined;
    if ((body.on !== undefined && typeof body.on !== 'boolean') || (body.off !== undefined && !Array.isArray(body.off)) || (body.show !== undefined && !isReviewPlace(body.show)) || (body.matches !== undefined && (typeof body.matches !== 'object' || body.matches === null || Array.isArray(body.matches))) || !given) return { status: 400, body: { error: 'Give on, true or false; off, the sources switched off; show, where tickets appear (page, sidebar or both); or matches, tracker projects by Kestrel project.' } };
    store.setSettings(asTicketSettings({ ...store.view().settings, ...body }));
    void sync.check();
    return { status: 200, body: store.view().settings };
  }
  if (what === 'sources' && method === 'GET') return { status: 200, body: api.sources ? await api.sources() : [] };
  // Off, only what asks no tracker still answers: connecting one, how each stands, taking a ticket off work, and where its work would go.
  const worksWhileOff = what === 'jira' || what === 'linear' || what === 'detach' || what === 'project' || what === 'sources';
  if (!worksWhileOff && !ticketsOn(store.view())) throw new Refused(TICKETS_OFF_REASON);
  if (what === 'dismissed' && method === 'PUT') {
    const body = await readBody();
    const keys = keysOf(body.keys);
    if (!keys || typeof body.dismissed !== 'boolean') return { status: 400, body: { error: 'Give keys, a list of ticket keys, and dismissed, true or false.' } };
    store.dismiss(keys, body.dismissed);
    return { status: 200, body: { ok: true } };
  }
  if (what === 'seen' && method === 'PUT') {
    const body = await readBody();
    const keys = keysOf(body.keys);
    if (!keys || typeof body.seen !== 'boolean') return { status: 400, body: { error: 'Give keys, a list of ticket keys, and seen, true or false.' } };
    store.markSeen(keys, body.seen);
    return { status: 200, body: { ok: true } };
  }
  // A ticket's statuses: the moves its tracker allows now. An answer to a question, not held data.
  if (what === 'statuses' && method === 'GET') {
    const key = url.searchParams.get('key') ?? '';
    const ticket = store.ticket(key);
    if (!ticket) return { status: 404, body: { error: 'No such ticket.' } };
    const source = await sync.sourceOf(ticket);
    if (!source) throw new Refused(`${ticket.ref}’s tracker is not connected or is switched off in Settings → Tickets.`);
    return { status: 200, body: await source.statuses(ticket) };
  }
  // Move a ticket to a status by hand: one route, one function (move.ts), which the agent-proposed move will use too.
  if (what === 'move' && method === 'POST') {
    const body = await readBody();
    const key = opt(body.key);
    const to = opt(body.to);
    if (!key || !to) return { status: 400, body: { error: 'Give the ticket’s key and to, the status to move it to.' } };
    return { status: 200, body: await moveTicket({ store, sourceOf: sync.sourceOf }, key, to) };
  }
  // A comment the user typed on the ticket's page: the same function a comment a session proposed goes through.
  if (what === 'comment' && method === 'POST') {
    const body = await readBody();
    const key = opt(body.key);
    if (!key || typeof body.body !== 'string') return { status: 400, body: { error: 'Give the ticket’s key and body, the comment.' } };
    return { status: 201, body: await commentOnTicket({ store, sourceOf: sync.sourceOf, read: sync.read }, key, body.body) };
  }
  if (what === 'refresh' && method === 'POST') {
    await sync.check();
    return { status: 200, body: { ok: true } };
  }
  if (what === 'read' && method === 'POST') {
    const key = opt((await readBody()).key);
    if (!key) return { status: 400, body: { error: 'Give the ticket’s key.' } };
    if (!store.ticket(key)) return { status: 404, body: { error: 'Kestrel does not hold that ticket: it may have been closed or reassigned. Refresh the Tickets page.' } };
    void sync.read(key);
    return { status: 202, body: { ok: true } };
  }
  if (what === 'project' && method === 'GET') {
    const ticket = store.ticket(url.searchParams.get('key') ?? '');
    if (!ticket) return { status: 404, body: { error: 'No such ticket.' } };
    const project = await projectForTicket({ ...api.work, store }, ticket);
    return { status: 200, body: { projectId: project?.id ?? null } };
  }
  if (what === 'detach' && method === 'POST') {
    const body = await readBody();
    if ((body.attachedTo !== 'session' && body.attachedTo !== 'workstream') || !opt(body.id)) return { status: 400, body: { error: 'Give attachedTo, session or workstream, and its id.' } };
    store.detach(body.attachedTo, opt(body.id)!);
    return { status: 200, body: { ok: true } };
  }
  if (what === 'work' && method === 'POST') {
    const body = await readBody();
    const key = opt(body.key);
    if (!key) return { status: 400, body: { error: 'Give the ticket’s key.' } };
    if (typeof body.agent !== 'string' || !(body.agent in AGENT_LABEL)) throw new Refused('Choose which agent leads the work.');
    const permission = isPermissionLevel(body.permission) ? body.permission : undefined;
    const projectId = body.projectId === null ? null : opt(body.projectId);
    const session: Session = await workTicket({ ...api.work, store, read: sync.read }, key, {
      agent: body.agent as Agent,
      ...(opt(body.model) ? { model: opt(body.model) } : {}),
      ...(opt(body.effort) ? { effort: opt(body.effort) } : {}),
      ...(body.fast === true ? { fast: true } : {}),
      ...(permission ? { permission } : {}),
      ...('projectId' in body ? { projectId: projectId ?? null } : {}),
    });
    return { status: 201, body: session };
  }
  return null;
}
