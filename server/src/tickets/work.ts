// "Work this ticket" (docs/designs/tickets.md, section 6): one click starts a lead session whose first
// message is the ticket and the standing brief (brief.ts), in the Kestrel project the ticket belongs
// to where there is one, attaches the ticket to it and tags it with the ticket's key. A ticket that
// already has a lead gets that session back, not a second one.
import type { Project, Session, Workstream } from '../model.ts';
import { canonicalHost, remoteHost, remoteRepository } from '../pull-requests/choose.ts';
import type { StartRequest } from '../runtime/bring-up.ts';
import { Refused } from '../refused.ts';
import { isClosedTicket, matchedProjectId, plainName, ticketLead, type Ticket, type TicketDetail, type TicketMatches } from '../shared/tickets.ts';
import { ticketBrief } from './brief.ts';
import type { TicketStore } from './store.ts';

/** How the lead starts: the user's own choices for a new session, as the New session box has them. */
export type LeadChoices = Pick<StartRequest, 'agent' | 'model' | 'effort' | 'fast' | 'permission'> & { projectId?: string | null };

export interface WorkTicketDeps {
  store: TicketStore;
  projects(): Promise<readonly Project[]>;
  sessions(): Promise<readonly Session[]>;
  /** The workstreams, so a ticket a workstream works opens its lead rather than starting another. */
  workstreams?(): Promise<readonly Pick<Workstream, 'id' | 'sessionIds'>[]>;
  /** The URL of a folder's `origin` remote, or null. */
  originOf(path: string): Promise<string | null>;
  /** Ask the ticket's tracker for its description and comments (sync.ts `read`). */
  read(key: string): Promise<void>;
  start(req: StartRequest): Promise<Session>;
  tag(sessionId: string, tag: string): Promise<unknown>;
  /** Work on the ticket has started in this new session: Kestrel proposes In progress (runtime `proposeTicketStarted`). Not waited for. */
  started?(sessionId: string): void;
  now?: () => number;
}

/**
 * The Kestrel project a ticket belongs to: the one the user matched its tracker project or team to in
 * Settings → Tickets, else the one whose `origin` is the ticket's repository (a GitLab issue), else the
 * one named as the tracker names its project (`Platform`, `platform-api`). Null when none matches: the
 * lead then starts with no project and moves or delegates. Pure.
 */
export function matchProject(ticket: Pick<Ticket, 'project' | 'repository' | 'projectKey'>, projects: readonly Project[], origins: ReadonlyMap<string, string | null>, matches?: TicketMatches): Project | null {
  const matched = matchedProjectId(ticket, matches);
  const byUser = matched ? projects.find((p) => p.id === matched) : undefined;
  if (byUser) return byUser;
  if (ticket.repository) {
    const want = `${canonicalHost(ticket.repository.hostName)}/${ticket.repository.path}`.toLowerCase();
    const byRemote = projects.find((p) =>
      p.folders.some((f) => {
        const origin = origins.get(f.path);
        const host = origin ? remoteHost(origin) : null;
        const repo = origin ? remoteRepository(origin) : null;
        return host && repo && `${canonicalHost(host)}/${repo}`.toLowerCase() === want;
      }),
    );
    if (byRemote) return byRemote;
  }
  // Then by the tracker project's name, then its key (a Jira project's, a Linear team's).
  for (const name of [plainName(ticket.project), plainName(ticket.projectKey ?? '')]) {
    const found = name && projects.find((p) => plainName(p.name) === name || plainName(p.id) === name);
    if (found) return found;
  }
  return null;
}

/** The project a ticket's work would start in, for the button to say so before it is clicked. */
export async function projectForTicket(deps: Pick<WorkTicketDeps, 'projects' | 'originOf' | 'store'>, ticket: Ticket): Promise<Project | null> {
  const projects = await deps.projects();
  const paths = projects.flatMap((p) => p.folders.map((f) => f.path));
  const origins = new Map(await Promise.all(paths.map(async (path) => [path, await deps.originOf(path).catch(() => null)] as const)));
  return matchProject(ticket, projects, origins, deps.store.view().settings.matches);
}

/** Leads being started, by store and ticket: a second click while the first is still starting gets the same session. */
const starting = new WeakMap<TicketStore, Map<string, Promise<Session>>>();

/** Start the ticket's lead session, or give back the one already working on it (or being started). */
export function workTicket(deps: WorkTicketDeps, key: string, choices: LeadChoices): Promise<Session> {
  const byKey = starting.get(deps.store) ?? new Map<string, Promise<Session>>();
  starting.set(deps.store, byKey);
  const pending = byKey.get(key);
  if (pending) return pending;
  const work = startLead(deps, key, choices).finally(() => byKey.delete(key));
  byKey.set(key, work);
  return work;
}

async function startLead(deps: WorkTicketDeps, key: string, choices: LeadChoices): Promise<Session> {
  const ticket = deps.store.ticket(key);
  if (!ticket) throw new Refused('This ticket is no longer listed: it may have been closed or reassigned. Refresh the Tickets page.');
  const view = deps.store.view();
  const sessions = await deps.sessions();
  const lead = ticketLead(key, view.links, (await deps.workstreams?.()) ?? [], new Set(sessions.map((s) => s.id)));
  if (lead) return sessions.find((s) => s.id === lead)!;
  if (isClosedTicket(view, key)) throw new Refused(`${ticket.ref} is closed in ${ticket.tracker}. Reopen it from its status first if there is more to do.`);
  const project = choices.projectId !== undefined ? (choices.projectId ? ((await deps.projects()).find((p) => p.id === choices.projectId) ?? null) : null) : await projectForTicket(deps, ticket);
  if (choices.projectId && !project) throw new Refused(`No such project: ${choices.projectId}`);
  // The ticket as the tracker has it now; a tracker that cannot answer still lets the work start.
  if (deps.store.view().details[key]?.state !== 'ready') await deps.read(key).catch(() => undefined);
  const held = deps.store.view().details[key];
  const detail: TicketDetail | null = held?.state === 'ready' ? held.value : null;
  const session = await deps.start({
    agent: choices.agent,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.effort ? { effort: choices.effort } : {}),
    ...(choices.fast ? { fast: true } : {}),
    ...(choices.permission ? { permission: choices.permission } : {}),
    projectId: project?.id ?? null,
    prompt: ticketBrief(ticket, detail),
    title: `${ticket.ref}: ${ticket.title}`.slice(0, 120),
  });
  deps.store.attach({ ticketKey: key, attachedTo: 'session', id: session.id, role: 'lead', at: (deps.now ?? Date.now)() });
  await deps.tag(session.id, ticket.ref).catch((error: unknown) => console.error('[kestrel] could not tag the ticket’s session', error));
  deps.started?.(session.id);
  return session;
}
