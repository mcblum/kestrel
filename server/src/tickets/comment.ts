// Adding a comment to a ticket (docs/designs/tickets.md, section 8). One function, for the comment
// the user types on a ticket's page and the one a session proposed and the user allowed (the
// `ticket` suggestion). The tracker's own reason comes back as a `Refused`; on success the ticket is
// read again, so its page shows the comment.
import { Refused } from '../refused.ts';
import { reasonOf } from '../shared/sourced.ts';
import { TICKETS_OFF_REASON, ticketsOn, type Ticket } from '../shared/tickets.ts';
import type { TicketSource } from './source.ts';
import type { TicketStore } from './store.ts';

/** The longest comment sent to a tracker. */
export const TICKET_COMMENT_LIMIT = 10_000;

export interface CommentTicketDeps {
  store: TicketStore;
  sourceOf(ticket: Ticket): Promise<TicketSource | null>;
  read(key: string): Promise<void>;
}

/** Add `body` to the ticket as the signed-in user; resolves once the ticket has been read again. */
export async function commentOnTicket(deps: CommentTicketDeps, key: string, body: string): Promise<{ key: string; ref: string }> {
  if (!ticketsOn(deps.store.view())) throw new Refused(TICKETS_OFF_REASON);
  const ticket = deps.store.ticket(key);
  if (!ticket) throw new Refused('Kestrel does not hold that ticket.');
  const text = body.trim();
  if (!text) throw new Refused('Write the comment first.');
  if (text.length > TICKET_COMMENT_LIMIT) throw new Refused(`A comment can be at most ${TICKET_COMMENT_LIMIT} characters; this one is ${text.length}.`);
  const source = await deps.sourceOf(ticket);
  if (!source) throw new Refused(`${ticket.ref}’s tracker is not connected or is switched off in Settings → Tickets.`);
  try {
    await source.comment(ticket, text);
  } catch (error) {
    throw new Refused(reasonOf(error));
  }
  await deps.read(key).catch(() => undefined);
  return { key, ref: ticket.ref };
}
