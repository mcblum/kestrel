// GitLab work items (issues) as tickets, through `glab api` on a server glab is already signed in
// to, so no new sign-in: open issues assigned to the user across every project on that server, an
// issue's description and its comments (notes, without GitLab's own system notes), and the
// iteration each is in with whether it is the current one. Iterations are a paid GitLab feature; on
// a server without them every issue is in one list. The runner is injected: tests never call glab.
import { homedir } from 'node:os';
import { execRunner } from '../../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from '../../pull-requests/glab.ts';
import type { CommandRunner } from '../../pull-requests/types.ts';
import { ready, unavailable, type Sourced } from '../../shared/sourced.ts';
import { criteriaOf, type Ticket, type TicketCategory, type TicketComment, type TicketDetail, type TicketMove, type TicketSprint } from '../../shared/tickets.ts';
import type { TicketSource } from '../source.ts';

/** At most this many tickets per server: one page. */
export const GITLAB_TICKET_LIMIT = 100;

type Fields = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const DAY_MS = 86_400_000;

export const gitlabAssignedArgs = (host: string): string[] => ['api', `issues?scope=assigned_to_me&state=opened&per_page=${GITLAB_TICKET_LIMIT}`, '--hostname', host];
export const gitlabIssueArgs = (host: string, path: string, iid: number): string[] => ['api', `projects/${encodeURIComponent(path)}/issues/${iid}`, '--hostname', host];
export const gitlabNotesArgs = (host: string, path: string, iid: number): string[] => ['api', `projects/${encodeURIComponent(path)}/issues/${iid}/notes?sort=asc&order_by=created_at&per_page=50`, '--hostname', host];

/** The project's full path from `references.full` ("group/app#12"), else from the address. Pure. */
export function issuePath(item: Fields): string | null {
  const full = isFields(item.references) ? text(item.references.full) : '';
  const fromReference = /^(.+)#\d+$/.exec(full);
  if (fromReference) return fromReference[1]!;
  const fromUrl = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/\d+/.exec(text(item.web_url));
  return fromUrl ? fromUrl[1]! : null;
}

/** A status from the labels a board uses (`workflow::In progress`, `doing`, `In review`); else open, to do. Pure. */
export function labelStatus(labels: readonly string[]): { name: string; category: TicketCategory } {
  const scoped = labels.find((l) => /^(workflow|status|stage)::/i.test(l));
  const all = scoped ? [scoped] : labels;
  for (const label of all) {
    const name = label.replace(/^[^:]+::/, '');
    // "Not started" and "No review needed" say the opposite of the word they contain.
    if (/\b(not|un|no)[ -]?(started|review)/i.test(name)) continue;
    if (/review/i.test(name)) return { name, category: 'in-review' };
    if (/progress|doing|started|wip/i.test(name)) return { name, category: 'in-progress' };
  }
  return { name: scoped ? scoped.replace(/^[^:]+::/, '') : 'Open', category: 'todo' };
}

/** A priority from `priority::1`, `P2` or `priority: high`; null when none says. Pure. */
export function labelPriority(labels: readonly string[]): { priority: number; name: string } | null {
  for (const label of labels) {
    const n = /^(?:priority\s*::?\s*|p)([0-4])$/i.exec(label.trim());
    if (n) return { priority: Math.max(1, Number(n[1])), name: label };
    const word = /^priority\s*::?\s*(critical|highest|high|medium|low|lowest)$/i.exec(label.trim());
    if (word) return { priority: { critical: 1, highest: 1, high: 2, medium: 3, low: 4, lowest: 4 }[word[1]!.toLowerCase() as 'high'], name: word[1]! };
  }
  return null;
}

/** The issue's iteration as a sprint; current when GitLab says so (state 2 or "current") or today is inside its dates. Pure. */
export function iterationSprint(iteration: unknown, now: number): TicketSprint | null {
  if (!isFields(iteration)) return null;
  const start = Date.parse(text(iteration.start_date));
  const due = Date.parse(text(iteration.due_date));
  const name = text(iteration.title) || (text(iteration.start_date) && text(iteration.due_date) ? `Iteration ${text(iteration.start_date)} – ${text(iteration.due_date)}` : `Iteration ${String(iteration.iid ?? iteration.id ?? '')}`.trim());
  const current = iteration.state === 2 || iteration.state === 'current' || (Number.isFinite(start) && Number.isFinite(due) && now >= start && now < due + DAY_MS);
  return { name, current };
}

/**
 * A milestone as a sprint, where there is no iteration (the free tier has none; GitHub has only
 * milestones). Current only when it is open and today is inside its start and due dates; a milestone
 * with no start date (all of GitHub's) is never current, since nothing says when it began. Pure.
 */
export function milestoneSprint(milestone: unknown, now: number): TicketSprint | null {
  if (!isFields(milestone) || !text(milestone.title)) return null;
  const start = Date.parse(text(milestone.start_date));
  const due = Date.parse(text(milestone.due_date) || text(milestone.due_on));
  const open = milestone.state === 'active' || milestone.state === 'open';
  return { name: text(milestone.title), current: open && Number.isFinite(start) && Number.isFinite(due) && now >= start && now < due + DAY_MS };
}

/** GitLab issues are open or closed; a board's status comes from labels, which a move leaves alone. */
export const OPEN_ISSUE: TicketMove = { name: 'Open', category: 'todo' };
export const CLOSED_ISSUE: TicketMove = { name: 'Closed', category: 'done' };

/** Where an issue or GitHub issue can move: closed when it is open, open again when it is closed. Pure. */
export const openClosedMoves = (ticket: Pick<Ticket, 'status'>): TicketMove[] => [ticket.status.category === 'done' ? OPEN_ISSUE : CLOSED_ISSUE];

/** An issue's status: closed, or what its labels say. Pure. */
export function gitlabStatus(item: Fields): TicketMove {
  if (item.state === 'closed') return CLOSED_ISSUE;
  return labelStatus(Array.isArray(item.labels) ? item.labels.filter((l): l is string => typeof l === 'string') : []);
}

export const gitlabCommentArgs = (host: string, path: string, iid: number, body: string): string[] => ['api', '-X', 'POST', `projects/${encodeURIComponent(path)}/issues/${iid}/notes`, '-f', `body=${body}`, '--hostname', host];
export const gitlabMoveArgs = (host: string, path: string, iid: number, to: string): string[] => ['api', '-X', 'PUT', `projects/${encodeURIComponent(path)}/issues/${iid}`, '-f', `state_event=${to === CLOSED_ISSUE.name ? 'close' : 'reopen'}`, '--hostname', host];

/** One issue as a ticket; null for one Kestrel cannot name. Pure. */
export function mapGitlabIssue(item: Fields, host: string, now: number): Ticket | null {
  const path = issuePath(item);
  if (!path || typeof item.iid !== 'number') return null;
  const labels = Array.isArray(item.labels) ? item.labels.filter((l): l is string => typeof l === 'string') : [];
  const priority = labelPriority(labels);
  const assignee = Array.isArray(item.assignees) && isFields(item.assignees[0]) ? text(item.assignees[0].username) : '';
  const name = path.split('/').at(-1)!;
  return {
    key: `gitlab@${host}:${path}#${item.iid}`,
    source: `gitlab@${host}`,
    tracker: 'GitLab',
    ref: `${name}#${item.iid}`,
    title: text(item.title) || `#${item.iid}`,
    status: gitlabStatus(item),
    project: path,
    url: /^https?:\/\//.test(text(item.web_url)) ? text(item.web_url) : '',
    openedAt: Date.parse(text(item.created_at)) || 0,
    updatedAt: Date.parse(text(item.updated_at)) || 0,
    ...(priority ? { priority: priority.priority, priorityName: priority.name } : {}),
    ...(assignee ? { assignee } : {}),
    sprint: iterationSprint(item.iteration, now) ?? milestoneSprint(item.milestone, now),
    repository: { hostName: host, path },
  };
}

/** The list's answer as tickets. Throws when it is not a list. Pure. */
export function mapGitlabIssues(json: string, host: string, now: number): Ticket[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list');
  return parsed.filter(isFields).flatMap((item) => mapGitlabIssue(item, host, now) ?? []);
}

/** The comments people wrote, oldest first: GitLab's own system notes left out. Pure. */
export function mapGitlabNotes(json: string): TicketComment[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list of comments');
  return parsed
    .filter(isFields)
    .filter((note) => note.system !== true && text(note.body).trim())
    .map((note) => ({ author: isFields(note.author) ? text(note.author.username) || text(note.author.name) : '', at: Date.parse(text(note.created_at)) || 0, body: text(note.body) }));
}

/** Where a ticket's issue is, from its key (`gitlab@host:path#iid`). Pure. */
export function issueOfKey(key: string): { host: string; path: string; iid: number } | null {
  // The host may carry a port (`gitlab.corp:8443`); the project path never has a colon, so the last one splits them.
  const m = /^gitlab@(.+):([^:]+)#(\d+)$/.exec(key);
  return m ? { host: m[1]!, path: m[2]!, iid: Number(m[3]) } : null;
}

export function gitlabTicketSource(host: string, run: CommandRunner = execRunner, cwd: string = homedir(), now: () => number = Date.now): TicketSource {
  const glab = async (args: string[]): Promise<string> => (await run('glab', args, { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout;
  return {
    kind: `gitlab@${host}`,
    name: `GitLab (${host})`,
    async assignedToMe(): Promise<Sourced<Ticket[]>> {
      try {
        return ready(mapGitlabIssues(await glab(gitlabAssignedArgs(host)), host, now()));
      } catch (error) {
        return unavailable(error instanceof SyntaxError ? `glab gave an answer Kestrel cannot read: ${error.message}` : glabFailureReason(error, host));
      }
    },
    async read(ticket): Promise<Sourced<TicketDetail>> {
      const where = issueOfKey(ticket.key);
      if (!where) return unavailable(`${ticket.ref} is not a GitLab issue Kestrel can find.`);
      try {
        const [issue, notes] = await Promise.all([glab(gitlabIssueArgs(host, where.path, where.iid)), glab(gitlabNotesArgs(host, where.path, where.iid))]);
        const parsed: unknown = JSON.parse(issue);
        const description = isFields(parsed) ? text(parsed.description) : '';
        return ready({ description, criteria: criteriaOf(description), comments: mapGitlabNotes(notes) });
      } catch (error) {
        return unavailable(error instanceof SyntaxError ? `glab gave an answer Kestrel cannot read: ${error.message}` : glabFailureReason(error, host));
      }
    },
    async status(ticket): Promise<Sourced<TicketMove>> {
      const where = issueOfKey(ticket.key);
      if (!where) return unavailable(`${ticket.ref} is not a GitLab issue Kestrel can find.`);
      try {
        const parsed: unknown = JSON.parse(await glab(gitlabIssueArgs(host, where.path, where.iid)));
        if (!isFields(parsed)) return unavailable('glab did not answer with an issue');
        return ready(gitlabStatus(parsed));
      } catch (error) {
        return unavailable(error instanceof SyntaxError ? `glab gave an answer Kestrel cannot read: ${error.message}` : glabFailureReason(error, host));
      }
    },
    statuses: async (ticket) => ready(openClosedMoves(ticket)),
    async move(ticket, to): Promise<TicketMove> {
      const where = issueOfKey(ticket.key);
      if (!where) throw new Error(`${ticket.ref} is not a GitLab issue Kestrel can find.`);
      try {
        const parsed: unknown = JSON.parse(await glab(gitlabMoveArgs(host, where.path, where.iid, to)));
        return isFields(parsed) ? gitlabStatus(parsed) : to === CLOSED_ISSUE.name ? CLOSED_ISSUE : OPEN_ISSUE;
      } catch (error) {
        throw new Error(error instanceof SyntaxError ? `glab gave an answer Kestrel cannot read: ${error.message}` : glabFailureReason(error, host));
      }
    },
    async comment(ticket, body): Promise<void> {
      const where = issueOfKey(ticket.key);
      if (!where) throw new Error(`${ticket.ref} is not a GitLab issue Kestrel can find.`);
      try {
        await glab(gitlabCommentArgs(host, where.path, where.iid, body));
      } catch (error) {
        throw new Error(glabFailureReason(error, host));
      }
    },
  };
}
