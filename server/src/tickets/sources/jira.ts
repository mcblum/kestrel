// Jira Cloud issues as tickets, over Jira's REST API with the account's email and an API token the
// user pasted in Settings → Tickets (credentials.ts). Open issues assigned to the
// user (`assignee = currentUser()`, not done), the sprint each is in from the board's Sprint field
// (an active sprint is the current one), an issue's description and comments, and moving an issue
// through one of the transitions its workflow allows now. The fetch is
// injected: tests never reach Jira.
import { ready, reasonOf, unavailable, type Sourced } from '../../shared/sourced.ts';
import { criteriaOf, type Ticket, type TicketCategory, type TicketDetail, type TicketMove, type TicketSprint } from '../../shared/tickets.ts';
import type { JiraCredentials } from '../credentials.ts';
import type { TicketSource } from '../source.ts';

export const JIRA_TIMEOUT_MS = 15_000;
export const JIRA_TICKET_LIMIT = 100;
export const JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

type Fields = Record<string, unknown>;
type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;

/** The hosts a Jira Cloud site lives under. The token is sent nowhere else. */
export const JIRA_CLOUD_DOMAINS: readonly string[] = ['atlassian.net', 'jira.com'];

/**
 * A site as typed (`https://acme.atlassian.net/jira/…`, `acme.atlassian.net`) as its host, or null
 * when it is not a Jira Cloud site: the token goes in a header to this host, so a look-alike, an
 * address on the network or a typo elsewhere is refused before anything is sent. Only https is used. Pure.
 */
export function siteHost(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) return null;
  return JIRA_CLOUD_DOMAINS.some((d) => trimmed.endsWith(`.${d}`) && trimmed.length > d.length + 1) ? trimmed : null;
}

/** Jira's status category as Kestrel's; a status named for review is in review. Pure. */
export function jiraCategory(statusCategoryKey: string, statusName: string): TicketCategory {
  if (statusCategoryKey === 'done') return 'done';
  if (/review/i.test(statusName)) return 'in-review';
  return statusCategoryKey === 'indeterminate' ? 'in-progress' : 'todo';
}

const PRIORITY: Record<string, number> = { highest: 1, blocker: 1, critical: 1, high: 2, medium: 3, low: 4, lowest: 4, minor: 4, trivial: 4 };

/** The sprint an issue is in now: the active one if any, else the latest not closed. Pure. */
export function jiraSprint(value: unknown): TicketSprint | null {
  const sprints = (Array.isArray(value) ? value : []).filter(isFields).filter((s) => text(s.name));
  const active = sprints.find((s) => s.state === 'active');
  if (active) return { name: text(active.name), current: true };
  const open = sprints.filter((s) => s.state !== 'closed').at(-1);
  return open ? { name: text(open.name), current: false } : null;
}

/** The id of the board's Sprint field (`customfield_10020` on most sites), from `GET /field`. Pure. */
export function sprintFieldId(fields: unknown): string | null {
  if (!Array.isArray(fields)) return null;
  const found = fields.filter(isFields).find((f) => (isFields(f.schema) && text(f.schema.custom) === 'com.pyxis.greenhopper.jira:gh-sprint') || text(f.name) === 'Sprint');
  return found ? text(found.id) || null : null;
}

/** One issue from a search as a ticket. Pure. */
export function mapJiraIssue(issue: Fields, site: string, sprintField: string | null): Ticket | null {
  const key = text(issue.key);
  const f = isFields(issue.fields) ? issue.fields : null;
  if (!key || !f) return null;
  const status = isFields(f.status) ? f.status : {};
  const statusName = text(status.name) || 'Open';
  const categoryKey = isFields(status.statusCategory) ? text(status.statusCategory.key) : '';
  const priorityName = isFields(f.priority) ? text(f.priority.name) : '';
  const project = isFields(f.project) ? text(f.project.name) || text(f.project.key) : '';
  const assignee = isFields(f.assignee) ? text(f.assignee.displayName) : '';
  return {
    key: `jira:${site}/${key}`,
    source: 'jira',
    tracker: 'Jira',
    ref: key,
    title: text(f.summary) || key,
    status: { name: statusName, category: jiraCategory(categoryKey, statusName) },
    project,
    url: `https://${site}/browse/${key}`,
    openedAt: Date.parse(text(f.created)) || 0,
    updatedAt: Date.parse(text(f.updated)) || 0,
    ...(priorityName ? { priorityName, ...(PRIORITY[priorityName.toLowerCase()] ? { priority: PRIORITY[priorityName.toLowerCase()] } : {}) } : {}),
    ...(assignee ? { assignee } : {}),
    sprint: sprintField ? jiraSprint(f[sprintField]) : null,
    ...(isFields(f.project) && text(f.project.key) ? { projectKey: text(f.project.key) } : {}),
  };
}

/** An issue's description and comments from `GET /rest/api/2/issue` (wiki text, not the v3 document form). Pure. */
export function mapJiraDetail(raw: unknown): TicketDetail {
  const f = isFields(raw) && isFields(raw.fields) ? raw.fields : {};
  const description = text(f.description);
  const comments = isFields(f.comment) && Array.isArray(f.comment.comments) ? f.comment.comments.filter(isFields) : [];
  return {
    description,
    criteria: criteriaOf(description),
    comments: comments.map((c) => ({ author: isFields(c.author) ? text(c.author.displayName) : '', at: Date.parse(text(c.created)) || 0, body: text(c.body) })).filter((c) => c.body.trim()),
  };
}

/** Why Jira said no, said plainly. */
export function jiraRefusal(status: number, site: string): string {
  if (status === 401) return `Jira at ${site} did not accept the email and API token. Make a new token and connect again in Settings → Tickets.`;
  if (status === 403) return `Jira at ${site} says this account may not do that.`;
  if (status === 404) return `Jira at ${site} has no such page: check the site address.`;
  if (status === 429) return `Jira at ${site} asked Kestrel to slow down; it will ask again later.`;
  return `Jira at ${site} answered with an error (${status}).`;
}

/** Jira's own words for a refusal (`errorMessages`, `errors`) when it gives them, else the status said plainly. */
async function jiraReason(res: { status: number; json(): Promise<unknown> }, site: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const messages = isFields(body) ? [...(Array.isArray(body.errorMessages) ? body.errorMessages.filter((m): m is string => typeof m === 'string') : []), ...(isFields(body.errors) ? Object.values(body.errors).filter((m): m is string => typeof m === 'string') : [])] : [];
  return res.status !== 401 && messages.length > 0 ? `Jira said: ${messages.join(' ')}` : jiraRefusal(res.status, site);
}

/** The transitions an issue's workflow allows now, as moves to the status each leads to. Pure. */
export function jiraMoves(raw: unknown, own: string): { id: string; move: TicketMove }[] {
  const list = isFields(raw) && Array.isArray(raw.transitions) ? raw.transitions.filter(isFields) : [];
  const seen = new Set<string>([own]);
  return list.flatMap((t) => {
    const to = isFields(t.to) ? t.to : {};
    const name = text(to.name) || text(t.name);
    if (!text(t.id) || !name || seen.has(name)) return [];
    seen.add(name);
    const category = isFields(to.statusCategory) ? text(to.statusCategory.key) : '';
    return [{ id: text(t.id), move: { name, category: jiraCategory(category, name) } }];
  });
}

export interface JiraClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export function jiraClient(creds: JiraCredentials, fetcher: Fetch = fetch as unknown as Fetch): JiraClient {
  const auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
  const ask = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let res;
    try {
      res = await fetcher(`https://${creds.site}${path}`, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Could not reach Jira at ${creds.site}: ${reasonOf(error)}`);
    }
    if (!res.ok) throw new Error(await jiraReason(res, creds.site));
    return res.status === 204 ? null : res.json();
  };
  return { get: (path) => ask('GET', path), post: (path, body) => ask('POST', path, body) };
}

/** Who the token belongs to: the name Settings shows as "Connected as" (the email is null under some privacy settings, so the account id is last). Throws with Jira's reason. */
export async function jiraWhoAmI(client: JiraClient): Promise<string> {
  const me = await client.get('/rest/api/3/myself');
  const name = isFields(me) ? text(me.displayName) || text(me.emailAddress) || text(me.accountId) : '';
  if (!name) throw new Error('Jira did not say who the token belongs to.');
  return name;
}

const transitionsPath = (ticket: Pick<Ticket, 'ref'>): string => `/rest/api/3/issue/${encodeURIComponent(ticket.ref)}/transitions`;

/** One issue's status only (`GET /rest/api/3/issue/{key}?fields=status`). */
export const statusPath = (ticket: Pick<Ticket, 'ref'>): string => `/rest/api/3/issue/${encodeURIComponent(ticket.ref)}?fields=status`;

/** The status in an issue's answer, or null when it has none. Pure. */
export function mapJiraStatus(raw: unknown): TicketMove | null {
  const status = isFields(raw) && isFields(raw.fields) && isFields(raw.fields.status) ? raw.fields.status : null;
  const name = status ? text(status.name) : '';
  if (!status || !name) return null;
  return { name, category: jiraCategory(isFields(status.statusCategory) ? text(status.statusCategory.key) : '', name) };
}

export function jiraTicketSource(creds: JiraCredentials, fetcher?: Fetch): TicketSource {
  const client = jiraClient(creds, fetcher);
  let sprintField: Promise<string | null> | null = null;
  return {
    kind: 'jira',
    name: `Jira (${creds.site})`,
    async assignedToMe(): Promise<Sourced<Ticket[]>> {
      try {
        // The Sprint field's id is the site's own; asked once. A site without boards has none.
        sprintField ??= client.get('/rest/api/3/field').then(sprintFieldId, () => null);
        const field = await sprintField;
        const answer = await client.post('/rest/api/3/search/jql', { jql: JIRA_JQL, maxResults: JIRA_TICKET_LIMIT, fields: ['summary', 'status', 'priority', 'project', 'assignee', 'created', 'updated', ...(field ? [field] : [])] });
        const issues = isFields(answer) && Array.isArray(answer.issues) ? answer.issues.filter(isFields) : null;
        if (!issues) return unavailable('Jira gave an answer Kestrel cannot read.');
        return ready(issues.flatMap((issue) => mapJiraIssue(issue, creds.site, field) ?? []));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async read(ticket): Promise<Sourced<TicketDetail>> {
      try {
        return ready(mapJiraDetail(await client.get(`/rest/api/2/issue/${encodeURIComponent(ticket.ref)}?fields=description,comment`)));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async status(ticket): Promise<Sourced<TicketMove>> {
      try {
        const status = mapJiraStatus(await client.get(statusPath(ticket)));
        return status ? ready(status) : unavailable('Jira gave an answer Kestrel cannot read.');
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async statuses(ticket): Promise<Sourced<TicketMove[]>> {
      try {
        return ready(jiraMoves(await client.get(transitionsPath(ticket)), ticket.status.name).map((m) => m.move));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async move(ticket, to): Promise<TicketMove> {
      const target = jiraMoves(await client.get(transitionsPath(ticket)), ticket.status.name).find((m) => m.move.name === to);
      if (!target) throw new Error(`Jira’s workflow does not let ${ticket.ref} move to “${to}” now.`);
      await client.post(transitionsPath(ticket), { transition: { id: target.id } });
      return target.move;
    },
    async comment(ticket, body): Promise<void> {
      // Version 2 takes the comment as plain text, as `read` reads it; version 3 wants Atlassian's document format.
      await client.post(`/rest/api/2/issue/${encodeURIComponent(ticket.ref)}/comment`, { body });
    },
  };
}
