import type { MenuItem } from '@kestrel/server/menu';
import type { Ticket } from '@kestrel/server/tickets';
import { openView } from '../route.ts';
import { actions } from '../store.ts';
import { InboxRowMenu } from './InboxList.tsx';
import { openFrom } from './controls/anchor.ts';

export function TicketActionsMenu({ ticket, dismissed, canDismiss = true, showDetails = false }: { ticket: Ticket; dismissed?: boolean; canDismiss?: boolean; showDetails?: boolean }) {
  const items: MenuItem[] = [];
  if (showDetails) items.push({ id: 'ticket-detail', label: 'View ticket details' });
  if (ticket.url) items.push({ id: 'ticket-tracker', label: `Open in ${ticket.tracker}` });
  if (canDismiss) items.push({ id: 'ticket-dismiss', label: dismissed ? 'Restore' : 'Dismiss', separatorBefore: items.length > 0 });
  if (items.length === 0) return null;
  return (
    <InboxRowMenu
      label={`Actions for ${ticket.ref}`}
      onClick={(event) => openFrom(event.currentTarget, items, (item) => {
        if (item.id === 'ticket-detail') openView({ kind: 'ticket', id: ticket.key });
        if (item.id === 'ticket-tracker') window.open(ticket.url, '_blank', 'noreferrer');
        if (item.id === 'ticket-dismiss') void actions.dismissTickets([ticket.key], !dismissed);
      })}
    />
  );
}
