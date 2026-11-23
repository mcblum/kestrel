// The … at the end of a ticket's row and on its page: the ticket's one menu (server shared/menu.ts,
// `ticket`), the same one a right-click on its row opens.
import type { Ticket } from '@kestrel/server/tickets';
import { InboxRowMenu } from './InboxList.tsx';
import { openRowMenu } from './sidebarMenuTarget.ts';

export function TicketActionsMenu({ ticket, onPage = false }: { ticket: Ticket; /** On the ticket's own page: no way to that page. */ onPage?: boolean }) {
  return <InboxRowMenu label={`Actions for ${ticket.ref}`} onClick={(event) => openRowMenu('ticket', ticket.key, { from: event.currentTarget, gap: 4, returnFocus: event.currentTarget }, onPage)} />;
}
