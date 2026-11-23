// Moving a ticket to another status (docs/designs/tickets.md, section 8). One function, for the
// user's own move from a ticket's page or chip today and the move an agent proposes later (the
// `ticket` suggestion). The tracker's own reason comes back as a `Refused`; on success the store
// holds the ticket's new status at once, so every window shows it before the next round of the sync.
import { Refused } from '../refused.ts';
import { reasonOf } from '../shared/sourced.ts';
import { TICKETS_OFF_REASON, ticketsOn, type Ticket, type TicketMove } from '../shared/tickets.ts';
import type { TicketSource } from './source.ts';
import type { TicketStore } from './store.ts';

export interface MoveTicketDeps {
  store: TicketStore;
  sourceOf(ticket: Ticket): Promise<TicketSource | null>;
}

/** What a move did: the status it left, for Undo to move it back the same way, and the one it has now. */
export interface TicketMoved {
  key: string;
  ref: string;
  from: TicketMove;
  to: TicketMove;
}

export async function moveTicket(deps: MoveTicketDeps, key: string, to: string): Promise<TicketMoved> {
  if (!ticketsOn(deps.store.view())) throw new Refused(TICKETS_OFF_REASON);
  const ticket = deps.store.ticket(key);
  if (!ticket) throw new Refused('Kestrel does not hold that ticket.');
  if (ticket.status.name === to) throw new Refused(`${ticket.ref} is already ${to}.`);
  const source = await deps.sourceOf(ticket);
  if (!source) throw new Refused(`${ticket.ref}’s tracker is not connected or is switched off in Settings → Tickets.`);
  let now: TicketMove;
  try {
    now = await source.move(ticket, to);
  } catch (error) {
    throw new Refused(reasonOf(error));
  }
  deps.store.setStatus(key, now);
  return { key, ref: ticket.ref, from: ticket.status, to: now };
}
