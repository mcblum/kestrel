// Linear issues as tickets, over Linear's GraphQL API (https://api.linear.app/graphql) with a personal
// API key the user pasted in Settings → Tickets (credentials.ts), sent as `Authorization: <key>` with
// no "Bearer", as Linear documents for personal keys. Open issues assigned to the signed-in user
// (`viewer.assignedIssues`, state type not completed, canceled or duplicate), an issue's description
// and comments, the states of its team it can move to, and a move (`issueUpdate` with `stateId`). A
// Linear cycle is the sprint; `isActive` says it is the current one. The field names were checked
// against Linear's published SDK schema (packages/sdk/src/schema.graphql), not against a workspace.
// The fetch is injected: tests never reach Linear.
import { ready, reasonOf, unavailable, type Sourced } from '../../shared/sourced.ts';
import { criteriaOf, type Ticket, type TicketCategory, type TicketDetail, type TicketMove, type TicketSprint } from '../../shared/tickets.ts';
import type { TicketSource } from '../source.ts';

export const LINEAR_URL = 'https://api.linear.app/graphql';
export const LINEAR_TIMEOUT_MS = 15_000;
export const LINEAR_TICKET_LIMIT = 100;
/** State types that are finished: not listed, and a move into one is done. */
const FINISHED = ['completed', 'canceled', 'duplicate'];

type Fields = Record<string, unknown>;
export type LinearFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const nodesOf = (value: unknown): Fields[] => (isFields(value) && Array.isArray(value.nodes) ? value.nodes.filter(isFields) : []);

const ISSUE_FIELDS = 'id identifier title url priority priorityLabel createdAt updatedAt state { id name type } team { id key name } cycle { name number isActive } assignee { name displayName }';
export const ASSIGNED_QUERY = `query Assigned($first: Int!, $finished: [String!]) { viewer { assignedIssues(first: $first, filter: { state: { type: { nin: $finished } } }) { nodes { ${ISSUE_FIELDS} } } } }`;
export const ISSUE_QUERY = 'query Issue($id: String!) { issue(id: $id) { description comments(first: 50) { nodes { body createdAt user { name displayName } } } } }';
export const STATES_QUERY = 'query States($id: String!) { issue(id: $id) { state { id name type } team { states(first: 100) { nodes { id name type position } } } } }';
export const STATUS_QUERY = 'query Status($id: String!) { issue(id: $id) { state { name type } } }';
export const COMMENT_MUTATION = `mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
export const MOVE_MUTATION = `mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { state { id name type } } } }`;
export const VIEWER_QUERY = 'query Me { viewer { name displayName email } }';

/**
 * Linear's state type as Kestrel's category: triage, backlog and unstarted are to do, started is in
 * progress, completed, canceled and duplicate are done. Linear has no type for in review, so a started
 * state whose name says review (a team's "In Review") is in review. Pure.
 */
export function linearCategory(type: string, name: string): TicketCategory {
  if (FINISHED.includes(type)) return 'done';
  if (type === 'started') return /review/i.test(name) ? 'in-review' : 'in-progress';
  return 'todo';
}

/** An issue's cycle as its sprint; the active cycle is the current one. A cycle with no name is "Cycle <number>". Pure. */
export function linearSprint(cycle: unknown): TicketSprint | null {
  if (!isFields(cycle)) return null;
  const name = text(cycle.name) || (typeof cycle.number === 'number' ? `Cycle ${cycle.number}` : '');
  return name ? { name, current: cycle.isActive === true } : null;
}

/** One issue as a ticket; null for one Kestrel cannot name. Pure. */
export function mapLinearIssue(issue: Fields): Ticket | null {
  const identifier = text(issue.identifier);
  if (!identifier) return null;
  const state = isFields(issue.state) ? issue.state : {};
  const team = isFields(issue.team) ? issue.team : {};
  const priority = typeof issue.priority === 'number' && issue.priority > 0 ? issue.priority : null;
  const assignee = isFields(issue.assignee) ? text(issue.assignee.displayName) || text(issue.assignee.name) : '';
  return {
    key: `linear:${identifier}`,
    source: 'linear',
    tracker: 'Linear',
    ref: identifier,
    title: text(issue.title) || identifier,
    status: { name: text(state.name) || 'Todo', category: linearCategory(text(state.type), text(state.name)) },
    project: text(team.name) || text(team.key),
    url: /^https:\/\//.test(text(issue.url)) ? text(issue.url) : '',
    openedAt: Date.parse(text(issue.createdAt)) || 0,
    updatedAt: Date.parse(text(issue.updatedAt)) || 0,
    ...(priority ? { priority, priorityName: text(issue.priorityLabel) || `P${priority}` } : {}),
    ...(assignee ? { assignee } : {}),
    sprint: linearSprint(issue.cycle),
    ...(text(team.key) ? { projectKey: text(team.key) } : {}),
  };
}

/** An issue's description and comments, oldest first. Pure. */
export function mapLinearDetail(data: unknown): TicketDetail {
  const issue = isFields(data) && isFields(data.issue) ? data.issue : {};
  const description = text(issue.description);
  const comments = nodesOf(issue.comments)
    .map((c) => ({ author: isFields(c.user) ? text(c.user.displayName) || text(c.user.name) : '', at: Date.parse(text(c.createdAt)) || 0, body: text(c.body) }))
    .filter((c) => c.body.trim())
    .sort((a, b) => a.at - b.at);
  return { description, criteria: criteriaOf(description), comments };
}

/** The team's states an issue can move to, in the team's order, its own left out. Pure. */
export function linearMoves(data: unknown): { id: string; move: TicketMove }[] {
  const issue = isFields(data) && isFields(data.issue) ? data.issue : {};
  const own = isFields(issue.state) ? text(issue.state.id) : '';
  const states = nodesOf(isFields(issue.team) ? issue.team.states : null).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  return states.filter((s) => text(s.id) && text(s.id) !== own).map((s) => ({ id: text(s.id), move: { name: text(s.name), category: linearCategory(text(s.type), text(s.name)) } }));
}

/** An issue's state in a `STATUS_QUERY` answer, or null when it has none. Pure. */
export function mapLinearStatus(data: unknown): TicketMove | null {
  const state = isFields(data) && isFields(data.issue) && isFields(data.issue.state) ? data.issue.state : null;
  const name = state ? text(state.name) : '';
  return state && name ? { name, category: linearCategory(text(state.type), name) } : null;
}

/** Why Linear said no, said plainly. */
export function linearRefusal(status: number): string {
  if (status === 400 || status === 401) return 'Linear did not accept the API key. Make a new one and connect again in Settings → Tickets.';
  if (status === 403) return 'Linear says this key may not do that.';
  if (status === 429) return 'Linear asked Kestrel to slow down; it will ask again later.';
  return `Linear answered with an error (${status}).`;
}

export type LinearClient = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

/** Ask Linear one query; throws an Error with Linear's own reason (its first GraphQL error, or the HTTP status). */
export function linearClient(key: string, fetcher: LinearFetch = fetch as unknown as LinearFetch): LinearClient {
  return async (query, variables = {}) => {
    let res;
    try {
      res = await fetcher(LINEAR_URL, { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`Could not reach Linear: ${reasonOf(error)}`);
    }
    const body: unknown = await res.json().catch(() => null);
    const errors = isFields(body) && Array.isArray(body.errors) ? body.errors.filter(isFields) : [];
    if (errors.length > 0) {
      const authFailed = errors.some((e) => isFields(e.extensions) && /AUTHENTICATION/i.test(text(e.extensions.code)));
      throw new Error(authFailed ? linearRefusal(401) : `Linear said: ${text(errors[0]!.message) || 'an error'}`);
    }
    if (!res.ok) throw new Error(linearRefusal(res.status));
    if (!isFields(body) || !isFields(body.data)) throw new Error('Linear gave an answer Kestrel cannot read.');
    return body.data;
  };
}

/** Who the key belongs to: the name Settings shows as "Connected as". Throws with Linear's reason. */
export async function linearWhoAmI(client: LinearClient): Promise<string> {
  const data = await client(VIEWER_QUERY);
  const me = isFields(data) && isFields(data.viewer) ? data.viewer : null;
  const name = me ? text(me.displayName) || text(me.name) || text(me.email) : '';
  if (!name) throw new Error('Linear did not say who the key belongs to.');
  return name;
}

export function linearTicketSource(key: string, fetcher?: LinearFetch): TicketSource {
  const client = linearClient(key, fetcher);
  const moves = async (ticket: Ticket) => linearMoves(await client(STATES_QUERY, { id: ticket.ref }));
  return {
    kind: 'linear',
    name: 'Linear',
    async assignedToMe(): Promise<Sourced<Ticket[]>> {
      try {
        const data = await client(ASSIGNED_QUERY, { first: LINEAR_TICKET_LIMIT, finished: FINISHED });
        const viewer = isFields(data) && isFields(data.viewer) ? data.viewer : null;
        if (!viewer) return unavailable('Linear gave an answer Kestrel cannot read.');
        return ready(nodesOf(viewer.assignedIssues).flatMap((issue) => mapLinearIssue(issue) ?? []));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async read(ticket): Promise<Sourced<TicketDetail>> {
      try {
        return ready(mapLinearDetail(await client(ISSUE_QUERY, { id: ticket.ref })));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async status(ticket): Promise<Sourced<TicketMove>> {
      try {
        const status = mapLinearStatus(await client(STATUS_QUERY, { id: ticket.ref }));
        return status ? ready(status) : unavailable('Linear gave an answer Kestrel cannot read.');
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async statuses(ticket): Promise<Sourced<TicketMove[]>> {
      try {
        return ready((await moves(ticket)).map((m) => m.move));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async move(ticket, to): Promise<TicketMove> {
      const target = (await moves(ticket)).find((m) => m.move.name === to);
      if (!target) throw new Error(`Linear has no state “${to}” that ${ticket.ref} can move to.`);
      const data = await client(MOVE_MUTATION, { id: ticket.ref, stateId: target.id });
      const payload = isFields(data) && isFields(data.issueUpdate) ? data.issueUpdate : null;
      if (!payload || payload.success !== true) throw new Error(`Linear did not move ${ticket.ref}.`);
      const state = isFields(payload.issue) && isFields(payload.issue.state) ? payload.issue.state : null;
      return state ? { name: text(state.name), category: linearCategory(text(state.type), text(state.name)) } : target.move;
    },
    async comment(ticket, body): Promise<void> {
      const data = await client(COMMENT_MUTATION, { issueId: ticket.ref, body });
      const payload = isFields(data) && isFields(data.commentCreate) ? data.commentCreate : null;
      if (!payload || payload.success !== true) throw new Error(`Linear did not add the comment to ${ticket.ref}.`);
    },
  };
}
