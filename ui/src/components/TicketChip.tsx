// The ticket a session or workstream works on, as a chip: its key and title, opening the ticket's page
// (docs/designs/tickets.md, section 7), and beside it its live status, which a click moves (TicketStatus). Grey like every chip: a ticket's status is
// words, never a colour. Read through `ticketOf`, so a workstream's sessions show its lead's ticket.
import { Ticket } from 'lucide-react';
import type { Ticket as TicketData, TicketLink } from '@kestrel/server/tickets';
import { openView, opener } from '../route.ts';
import { useSessionTicket, useWorkstreamTicket } from '../tickets.ts';
import { TicketStatus } from './TicketStatus.tsx';

function Chip({ found }: { found: { link: TicketLink; ticket: TicketData | undefined } }) {
  const { link, ticket } = found;
  const ref = ticket?.ref ?? link.ticketKey.replace(/^[^:]+:/, '');
  return (
    <span className="ticket-chip-group">
      <button type="button" className="tag-chip workstream-chip ticket-chip" title={ticket ? `${ref}: ${ticket.title}. Open the ticket` : `Open the ticket ${ref}`} {...opener((newTab) => openView({ kind: 'ticket', id: link.ticketKey }, newTab))}>
        <Ticket aria-hidden />
        <span className="workstream-chip-name">
          {ref}
          {ticket && ` · ${ticket.title}`}
        </span>
      </button>
      {ticket && <TicketStatus ticket={ticket} className="tag-chip ticket-status-chip" />}
    </span>
  );
}

export function SessionTicketChip({ sessionId }: { sessionId: string }) {
  const found = useSessionTicket(sessionId);
  return found ? <Chip found={found} /> : null;
}

export function WorkstreamTicketChip({ workstreamId }: { workstreamId: string }) {
  const found = useWorkstreamTicket(workstreamId);
  return found ? <Chip found={found} /> : null;
}
