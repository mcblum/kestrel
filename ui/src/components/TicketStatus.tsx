// A ticket's status, as a control (docs/designs/tickets.md, section 8): it says the status, and a click
// lists the statuses the tracker lets this ticket move to now and makes the one picked (`moveTicket`,
// with a toast and Undo). The moves are an answer asked for on each click, not held data: a tracker's
// workflow can change between clicks. Grey like every control: a status is words, never a colour.
import { ChevronDown } from 'lucide-react';
import type { MenuItem } from '@kestrel/server/menu';
import type { Sourced } from '@kestrel/server/sourced';
import type { Ticket, TicketMove } from '@kestrel/server/tickets';
import { contextMenu } from '../menuState.ts';
import { actions, call } from '../store.ts';

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function itemsFor(ticket: Ticket, moves: Sourced<TicketMove[]>): MenuItem[] {
  const own: MenuItem = { id: `ticket-status:${ticket.status.name}`, label: ticket.status.name, checked: true, disabled: true };
  if (moves.state === 'loading') return [own, { id: 'ticket-status:loading', label: 'Asking the tracker…', disabled: true }];
  if (moves.state === 'unavailable') return [own, { id: 'ticket-status:none', label: 'Cannot move it now', disabled: true, hint: moves.reason }];
  if (moves.value.length === 0) return [own, { id: 'ticket-status:none', label: 'No other status', disabled: true, hint: `${ticket.tracker} offers no other status for ${ticket.ref} now.` }];
  return [own, ...moves.value.map((m, i) => ({ id: `ticket-status:move:${m.name}`, label: m.label ?? m.name, ...(i === 0 ? { separatorBefore: true } : {}) }))];
}

export function TicketStatus({ ticket, className = 'secondary-button small' }: { ticket: Ticket; className?: string }) {
  const open = async (button: HTMLButtonElement) => {
    if (contextMenu.current()) return contextMenu.close();
    const onPick = (item: MenuItem) => {
      const name = item.id.replace(/^ticket-status:move:/, '');
      if (item.id.startsWith('ticket-status:move:')) void actions.moveTicket(ticket.key, name);
    };
    contextMenu.openFrom(button, itemsFor(ticket, { state: 'loading' }), { onPick, returnFocus: button });
    const mine = contextMenu.current();
    let moves: Sourced<TicketMove[]>;
    try {
      moves = await call<Sourced<TicketMove[]>>(`/api/tickets/statuses?key=${encodeURIComponent(ticket.key)}`);
    } catch (error) {
      moves = { state: 'unavailable', reason: reasonOf(error) };
    }
    // Only into this menu, still open: not one opened since.
    if (contextMenu.current() === mine) contextMenu.replace(itemsFor(ticket, moves));
  };
  return (
    <button type="button" className={className} title={`${ticket.ref} is ${ticket.status.name}. Move it to another status`} aria-haspopup="menu" onClick={(e) => void open(e.currentTarget)}>
      {ticket.status.name} <ChevronDown aria-hidden />
    </button>
  );
}
