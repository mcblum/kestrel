// GitHub issues as tickets, through `gh api` with the sign-in Kestrel already uses for pull requests
// ("borrow, do not build"): one search for open issues assigned to the user across every repository,
// and an issue's description and comments. GitHub issues have no sprint, so every one is in the rest
// of the list; status and priority come from labels, as GitLab's do. The runner is injected: tests
// never call gh.
import { homedir } from 'node:os';
import { execRunner, ghFailureReason, GH_TIMEOUT_MS } from '../../pull-requests/github.ts';
import type { CommandRunner } from '../../pull-requests/types.ts';
import { GITHUB_HOST, repositoryOfUrl } from '../../review-requests/github.ts';
import { ready, unavailable, type Sourced } from '../../shared/sourced.ts';
import { criteriaOf, type Ticket, type TicketComment, type TicketDetail, type TicketMove } from '../../shared/tickets.ts';
import type { TicketSource } from '../source.ts';
import { CLOSED_ISSUE, labelPriority, labelStatus, milestoneSprint, OPEN_ISSUE, openClosedMoves } from './gitlab.ts';

export const GITHUB_TICKET_QUERY = 'is:issue is:open assignee:@me archived:false';
/** At most this many tickets: one page. */
export const GITHUB_TICKET_LIMIT = 100;

type Fields = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;

export const githubAssignedArgs = (): string[] => ['api', '-X', 'GET', 'search/issues', '-f', `q=${GITHUB_TICKET_QUERY}`, '-F', `per_page=${GITHUB_TICKET_LIMIT}`];
export const githubIssueArgs = (repository: string, number: number): string[] => ['api', `repos/${repository}/issues/${number}`];
export const githubMoveArgs = (repository: string, number: number, to: string): string[] => ['api', '-X', 'PATCH', `repos/${repository}/issues/${number}`, '-f', `state=${to === CLOSED_ISSUE.name ? 'closed' : 'open'}`];
export const githubCommentArgs = (repository: string, number: number, body: string): string[] => ['api', '-X', 'POST', `repos/${repository}/issues/${number}/comments`, '-f', `body=${body}`];
export const githubCommentsArgs = (repository: string, number: number): string[] => ['api', `repos/${repository}/issues/${number}/comments?per_page=50`];

const labelsOf = (item: Fields): string[] => (Array.isArray(item.labels) ? item.labels.flatMap((l) => (typeof l === 'string' ? [l] : isFields(l) && text(l.name) ? [text(l.name)] : [])) : []);

/** One search item as a ticket; null for a pull request or one Kestrel cannot name. Pure. */
export function mapGithubIssue(item: Fields): Ticket | null {
  const repository = repositoryOfUrl(item.repository_url);
  if (!repository || typeof item.number !== 'number' || isFields(item.pull_request)) return null;
  const labels = labelsOf(item);
  const priority = labelPriority(labels);
  const assignee = Array.isArray(item.assignees) && isFields(item.assignees[0]) ? text(item.assignees[0].login) : '';
  return {
    key: `github:${repository}#${item.number}`,
    source: 'github',
    tracker: 'GitHub',
    ref: `${repository.split('/')[1]}#${item.number}`,
    title: text(item.title) || `#${item.number}`,
    status: githubStatus(item),
    project: repository,
    url: /^https:\/\//.test(text(item.html_url)) ? text(item.html_url) : '',
    openedAt: Date.parse(text(item.created_at)) || 0,
    updatedAt: Date.parse(text(item.updated_at)) || 0,
    ...(priority ? { priority: priority.priority, priorityName: priority.name } : {}),
    ...(assignee ? { assignee } : {}),
    sprint: milestoneSprint(item.milestone, 0), // GitHub milestones have no start date, so never current: `now` does not matter
    repository: { hostName: GITHUB_HOST, path: repository },
  };
}

/** An issue's status: closed, or what its labels say. Pure. */
export const githubStatus = (item: Fields): TicketMove => (item.state === 'closed' ? CLOSED_ISSUE : labelStatus(labelsOf(item)));

/** The search's answer as tickets. Throws when it is not a search result. Pure. */
export function mapGithubIssues(json: string): Ticket[] {
  const parsed: unknown = JSON.parse(json);
  if (!isFields(parsed) || !Array.isArray(parsed.items)) throw new Error('gh did not answer with a search result');
  return parsed.items.filter(isFields).flatMap((item) => mapGithubIssue(item) ?? []);
}

/** An issue's comments, oldest first. Pure. */
export function mapGithubComments(json: string): TicketComment[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('gh did not answer with a list of comments');
  return parsed.filter(isFields).filter((c) => text(c.body).trim()).map((c) => ({ author: isFields(c.user) ? text(c.user.login) : '', at: Date.parse(text(c.created_at)) || 0, body: text(c.body) }));
}

/** Where a ticket's issue is, from its key (`github:owner/name#12`). Pure. */
export function githubIssueOfKey(key: string): { repository: string; number: number } | null {
  const m = /^github:([^/#]+\/[^/#]+)#(\d+)$/.exec(key);
  return m ? { repository: m[1]!, number: Number(m[2]) } : null;
}

const reasonOf = (error: unknown): string => (error instanceof SyntaxError ? `gh gave an answer Kestrel cannot read: ${error.message}` : ghFailureReason(error));

export function githubTicketSource(run: CommandRunner = execRunner, cwd: string = homedir()): TicketSource {
  const gh = async (args: string[]): Promise<string> => (await run('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout;
  return {
    kind: 'github',
    name: 'GitHub',
    async assignedToMe(): Promise<Sourced<Ticket[]>> {
      try {
        return ready(mapGithubIssues(await gh(githubAssignedArgs())));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async read(ticket): Promise<Sourced<TicketDetail>> {
      const where = githubIssueOfKey(ticket.key);
      if (!where) return unavailable(`${ticket.ref} is not a GitHub issue Kestrel can find.`);
      try {
        const [issue, comments] = await Promise.all([gh(githubIssueArgs(where.repository, where.number)), gh(githubCommentsArgs(where.repository, where.number))]);
        const parsed: unknown = JSON.parse(issue);
        const description = isFields(parsed) ? text(parsed.body) : '';
        return ready({ description, criteria: criteriaOf(description), comments: mapGithubComments(comments) });
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    async status(ticket): Promise<Sourced<TicketMove>> {
      const where = githubIssueOfKey(ticket.key);
      if (!where) return unavailable(`${ticket.ref} is not a GitHub issue Kestrel can find.`);
      try {
        const parsed: unknown = JSON.parse(await gh(githubIssueArgs(where.repository, where.number)));
        if (!isFields(parsed)) return unavailable('gh did not answer with an issue');
        return ready(githubStatus(parsed));
      } catch (error) {
        return unavailable(reasonOf(error));
      }
    },
    statuses: async (ticket) => ready(openClosedMoves(ticket)),
    async move(ticket, to): Promise<TicketMove> {
      const where = githubIssueOfKey(ticket.key);
      if (!where) throw new Error(`${ticket.ref} is not a GitHub issue Kestrel can find.`);
      try {
        const parsed: unknown = JSON.parse(await gh(githubMoveArgs(where.repository, where.number, to)));
        return isFields(parsed) ? githubStatus(parsed) : to === CLOSED_ISSUE.name ? CLOSED_ISSUE : OPEN_ISSUE;
      } catch (error) {
        throw new Error(reasonOf(error));
      }
    },
    async comment(ticket, body): Promise<void> {
      const where = githubIssueOfKey(ticket.key);
      if (!where) throw new Error(`${ticket.ref} is not a GitHub issue Kestrel can find.`);
      try {
        await gh(githubCommentArgs(where.repository, where.number, body));
      } catch (error) {
        throw new Error(reasonOf(error));
      }
    },
  };
}
