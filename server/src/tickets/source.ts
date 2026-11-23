// Where tickets come from (docs/designs/tickets.md, section 2). One interface for every tracker;
// nothing outside tickets/sources/ knows which tracker is in use, as nothing outside persistence/
// knows the database. A source lists and reads tickets, and moves one to another status when the user
// picks it (section 8), and adds a comment the user allowed (the `ticket` suggestion).
import type { Ticket, TicketDetail, TicketMove } from '../shared/tickets.ts';
import type { Sourced } from '../shared/sourced.ts';

export interface TicketSource {
  /** `gitlab`, `jira`, `fake`: the first part of every key it gives. */
  kind: string;
  /** How the tracker is named to a person: GitLab, Jira. */
  name: string;
  /** Open tickets assigned to the signed-in user. Never throws: a tracker that cannot answer says why. */
  assignedToMe(): Promise<Sourced<Ticket[]>>;
  /** One ticket's description, criteria and comments. Never throws. */
  read(ticket: Ticket): Promise<Sourced<TicketDetail>>;
  /**
   * The ticket's status now, asked of the tracker for this one ticket. Used when a ticket Kestrel held
   * leaves the assigned list, to tell a closed ticket from a reassigned one. Never throws.
   */
  status(ticket: Ticket): Promise<Sourced<TicketMove>>;
  /** The statuses the tracker lets this ticket move to now, its own status left out. Never throws. A tracker with only open and closed offers what it has. */
  statuses(ticket: Ticket): Promise<Sourced<TicketMove[]>>;
  /** Move the ticket to the status named, and say the status it has now. Throws an Error carrying the tracker's own reason. */
  move(ticket: Ticket, to: string): Promise<TicketMove>;
  /** Add a comment to the ticket, as the signed-in user. Throws an Error carrying the tracker's own reason. */
  comment(ticket: Ticket, body: string): Promise<void>;
}
