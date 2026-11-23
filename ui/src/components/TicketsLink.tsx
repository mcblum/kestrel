// The Tickets row of the sidebar's top menu (and its button on the folded rail): the page with every
// ticket assigned to the user, how many are new, and how many wait in all, as the Code reviews row is.
// While tickets are off (Settings → Tickets), or shown only in the sidebar's TICKETS section, neither is drawn.
import { Ticket } from 'lucide-react';
import { openView, opener } from '../route.ts';
import { hasTicketLink, ticketsOn } from '@kestrel/server/tickets';
import { useApp } from '../store.ts';

/** Whether the top menu has the Tickets row: tickets on, and shown on their page (`hasTicketLink`). */
const useTicketLink = (): boolean => useApp((s) => hasTicketLink({ on: ticketsOn(s.tickets), show: s.tickets.settings.show }));

export function TicketsLink({ active }: { active: boolean }) {
  const on = useTicketLink();
  return on ? <TicketsRow active={active} /> : null;
}

function TicketsRow({ active }: { active: boolean }) {
  const waiting = useApp((s) => s.tickets.tickets.length);
  const unread = useApp((s) => s.tickets.unread.length);
  return (
    <button className={`side-link${active ? ' active' : ''}`} {...opener((newTab) => openView({ kind: 'tickets' }, newTab))}>
      <Ticket aria-hidden />
      <span className="link-label">Tickets</span>
      {unread > 0 && (
        <span className="review-unread" aria-label={`${unread} new`} title={`${unread} new: assigned since you last looked`}>
          {unread}
        </span>
      )}
      {waiting > 0 && <span className="link-count" aria-label={`${waiting} assigned to you`} title={`${waiting} assigned to you`}>{waiting}</span>}
    </button>
  );
}

export function TicketsRailButton({ active }: { active: boolean }) {
  const on = useTicketLink();
  return on ? <TicketsRail active={active} /> : null;
}

function TicketsRail({ active }: { active: boolean }) {
  const unread = useApp((s) => s.tickets.unread.length);
  return (
    <button className={`rail-button${active ? ' active' : ''}`} aria-label={unread ? `Tickets, ${unread} new` : 'Tickets'} title={unread ? `Tickets · ${unread} new` : 'Tickets'} aria-current={active ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'tickets' }, newTab))}>
      <Ticket aria-hidden />
      {unread > 0 && <span className="status-dot rail-dot green" aria-hidden />}
    </button>
  );
}
