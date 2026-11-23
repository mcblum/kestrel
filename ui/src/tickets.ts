// Work this ticket from the page: the lead starts with the user's own choices for a new session (the
// New session box's agent, model and mode), and is opened. One function, for the ticket's page and
// its row's menu alike.
import type { AppState } from './store.ts';
import { useMemo } from 'react';
import { ticketLead, ticketOf, ticketOfWorkstream, findTicket, type Ticket, type TicketLink } from '@kestrel/server/tickets';
import { openSession } from './route.ts';
import { actions, useApp } from './store.ts';
import { startingControls, tabActions, tabsView } from './tabsStore.ts';

/** Start (or open) the ticket's lead session. `projectId` null starts it with no project; absent, in the project matched to the ticket. */
export async function workTicket(key: string, newTab: boolean, projectId?: string | null): Promise<void> {
  const c = startingControls(tabsView());
  const session = await actions.workTicket({ key, agent: c.agent, model: c.model, ...(c.effort ? { effort: c.effort } : {}), ...(c.fast ? { fast: true } : {}), permission: c.permission, ...(projectId !== undefined ? { projectId } : {}) });
  if (!session) return;
  // Opened before the workspace's push lists it: keep its tab meanwhile, as a fork's is.
  tabActions.expect(session.id);
  openSession(session.id, newTab);
}

const NO_WORKSTREAMS: readonly never[] = [];

/** The ticket a session works on, with the ticket as last held; null when it has none. */
export function useSessionTicket(sessionId: string): { link: TicketLink; ticket: Ticket | undefined } | null {
  const links = useApp((s) => s.tickets.links);
  const workstreams = useApp((s) => s.workspace?.workstreams ?? NO_WORKSTREAMS);
  const view = useApp((s) => s.tickets);
  const link = useMemo(() => ticketOf(sessionId, links, workstreams), [sessionId, links, workstreams]);
  return link ? { link, ticket: findTicket(view, link.ticketKey) } : null;
}

/** A workstream's ticket, with the ticket as last held; null when it has none. */
export function useWorkstreamTicket(workstreamId: string): { link: TicketLink; ticket: Ticket | undefined } | null {
  const links = useApp((s) => s.tickets.links);
  const stream = useApp((s) => s.workspace?.workstreams.find((w) => w.id === workstreamId));
  const view = useApp((s) => s.tickets);
  const link = useMemo(() => (stream ? ticketOfWorkstream(stream, links) : null), [stream, links]);
  return link ? { link, ticket: findTicket(view, link.ticketKey) } : null;
}

/** The session leading the work on a ticket (shared/tickets.ts `ticketLead`), read from the store. A selector: it returns an id, so a row re-renders only when the lead changes. */
export function ticketLeadIn(s: AppState, key: string): string | null {
  const workspace = s.workspace;
  if (!workspace) return null;
  return ticketLead(key, s.tickets.links, workspace.workstreams, new Set(workspace.sessions.map((x) => x.id)));
}
