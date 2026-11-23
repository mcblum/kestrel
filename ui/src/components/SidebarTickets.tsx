// The sidebar's TICKETS section (Settings → Tickets → Where tickets show: the sidebar, or both), with
// the parts of CODE REVIEWS (SidebarReviews.tsx):
//   - A ticket under way is its lead session's own row (the Sidebar's, through `renderSession`): the
//     lead has left its project for this one (shared/pinned-homes.ts `tickets`), so nothing is drawn
//     twice. A ticket under way whose lead is drawn elsewhere (under PINNED, say) has a ticket row that
//     opens the lead. Every ticket under way is listed, first.
//   - A ticket nobody has started on is a two-line ticket row: its title, then its key, project and
//     status, with how long ago it changed at the line's end. A click opens its page.
//   - Only the first few of those are listed; "Show more" opens the Tickets page, where every ticket is.
// Not drawn while empty or while tickets are off.
import { memo, useMemo, type ReactNode } from 'react';
import type { TreeNode } from '@kestrel/server/model';
import type { TicketLeadRow } from '@kestrel/server/pinned-homes';
import { hasTicketSection, orderTickets, TICKET_SECTION_LIMIT, ticketsOn, ticketsUnderWay, type Ticket } from '@kestrel/server/tickets';
import { agoText } from '@kestrel/server/when';
import { withinLimit } from '@kestrel/server/review-requests';
import { openSession, openView, opener, type Route } from '../route.ts';
import { useApp } from '../store.ts';
import { ticketLeadIn } from '../tickets.ts';
import { useMinuteNow } from '../useNow.ts';
import { Heading, useSectionOpen } from './SidebarHeading.tsx';

/** A ticket as a two-line row: in TICKETS when nobody has started on it, or when its lead is drawn elsewhere. */
const TicketRow = memo(function TicketRow({ ticket, active }: { ticket: Ticket; active: boolean }) {
  const unread = useApp((s) => s.tickets.unread.includes(ticket.key));
  const lead = useApp((s) => ticketLeadIn(s, ticket.key));
  const updated = agoText(ticket.updatedAt ?? 0, useMinuteNow());
  return (
    <button
      type="button"
      className={`side-link review-link${active ? ' active' : ''}`}
      data-menu-kind="ticket"
      data-menu-id={ticket.key}
      title={`${ticket.title}\n${ticket.ref} · ${ticket.status.name}`}
      {...opener((newTab) => (lead ? openSession(lead, newTab) : openView({ kind: 'ticket', id: ticket.key }, newTab)))}
    >
      <span className="review-label">
        <span className="review-title">{ticket.title}</span>
        <span className="review-second">
          <span className="review-detail">{[ticket.ref, ticket.project, ticket.status.name].filter(Boolean).join(' · ')}</span>
          {ticket.updatedAt ? <span className="review-age" title={`Changed ${updated}`}>{updated}</span> : null}
        </span>
      </span>
      <span className={`status-dot row-dot ${unread ? 'green' : 'idle'}`} role="img" aria-label={unread ? 'New' : 'Assigned to you'} title={unread ? 'New: you have not opened it yet' : 'Assigned to you'} />
    </button>
  );
});

type Row = { kind: 'ticket'; ticket: Ticket; started: boolean } | { kind: 'lead'; ticket: Ticket; node: TreeNode };

interface Props {
  route: Route | null;
  /** The leads drawn here (shared/pinned-homes.ts `tickets`). */
  rows: readonly TicketLeadRow[];
  activeId: string | null;
  renderSession: (node: TreeNode) => ReactNode;
}

const NO_IDS: ReadonlySet<string> = new Set();

export function SidebarTickets({ route, rows, activeId, renderSession }: Props) {
  const view = useApp((s) => s.tickets);
  const sessions = useApp((s) => s.workspace?.sessions);
  const workstreams = useApp((s) => s.workspace?.workstreams);
  const open = useSectionOpen('tickets');
  const section = useApp((s) => hasTicketSection({ on: ticketsOn(s.tickets), show: s.tickets.settings.show }));
  const list = useMemo((): Row[] => {
    const live = sessions ? new Set(sessions.map((s) => s.id)) : NO_IDS;
    const underWay = ticketsUnderWay(view.links, live, new Set((workstreams ?? []).map((w) => w.id)));
    const leads = new Map(rows.map((row) => [row.key, row.node]));
    const ordered = orderTickets(view.tickets);
    const started = ordered.filter((t) => underWay.has(t.key));
    const rest = ordered.filter((t) => !underWay.has(t.key));
    return [
      ...started.map((ticket): Row => (leads.has(ticket.key) ? { kind: 'lead', ticket, node: leads.get(ticket.key)! } : { kind: 'ticket', ticket, started: true })),
      ...rest.map((ticket): Row => ({ kind: 'ticket', ticket, started: false })),
    ];
  }, [view.tickets, view.links, sessions, workstreams, rows]);
  if (!section || list.length === 0) return null;
  const shown = route?.view.kind === 'ticket' ? route.view.id : null;
  const kept = (row: Row) => (row.kind === 'ticket' ? row.ticket.key === shown : treeHolds(row.node, activeId));
  // Open: every ticket under way, then the first few nobody has started on. The rest are on the page.
  const capped = withinLimit(list, TICKET_SECTION_LIMIT, (row) => row.kind === 'lead' || row.started || kept(row));
  const visible = open ? capped.shown : list.filter(kept);
  return (
    <>
      <Heading title="TICKETS" id="tickets" />
      {visible.map((row) =>
        row.kind === 'ticket' ? (
          <TicketRow key={row.ticket.key} ticket={row.ticket} active={row.ticket.key === shown} />
        ) : (
          <ul key={row.node.sessionId} className="tree flat">
            {renderSession(row.node)}
          </ul>
        ),
      )}
      {open && capped.hidden > 0 && (
        <button type="button" className="side-link review-more" title="Open the Tickets page" {...opener((newTab) => openView({ kind: 'tickets' }, newTab))}>
          <span className="link-label">Show more</span>
          <span className="link-count">{capped.hidden} more</span>
        </button>
      )}
    </>
  );
}

const treeHolds = (node: TreeNode, id: string | null): boolean => id !== null && (node.sessionId === id || node.children.some((child) => treeHolds(child, id)));
