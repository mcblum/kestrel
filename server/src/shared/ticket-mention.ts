// A ticket named in the user's own message (docs/designs/tickets.md, section 6): when the user writes a
// listed ticket's key or pastes its link, the session takes it up as Work this ticket would. Matched
// against the tickets Kestrel holds only; no tracker is asked. One pure function decides, for the
// server and its tests alike.
import { ticketOf, type Ticket, type TicketLink } from './tickets.ts';

/** What a user's message does to the session's ticket. */
export type MentionVerdict =
  /** It names no listed ticket. */
  | { type: 'none' }
  /** The session already has a ticket: it keeps it, whatever the message names. */
  | { type: 'keeps' }
  /** It names one ticket that is free: attach it here. */
  | { type: 'attach'; ticket: Ticket }
  /** The one ticket it names is under way in another session: it stays there. */
  | { type: 'elsewhere'; ticket: Ticket; sessionId: string }
  /** It names several: none is attached, and the user is offered a pick. */
  | { type: 'several'; tickets: Ticket[] };

export interface MentionSituation {
  sessionId: string;
  /** The listed tickets (shared/tickets.ts `TicketsView.tickets`). */
  tickets: readonly Ticket[];
  links: readonly TicketLink[];
  workstreams: readonly { id: string; sessionIds: string[] }[];
  /** Sessions that still exist and are not archived. */
  liveSessions: ReadonlySet<string>;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bare = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/[/?#]+$/, '').toLowerCase();

/** Whether the text names this ticket: its link (any scheme, case or trailing slash), or its key standing alone (PLAT-12, not PLAT-123). */
export function namesTicket(text: string, ticket: Pick<Ticket, 'ref' | 'url'>): boolean {
  if (ticket.url) {
    const want = bare(ticket.url);
    const urls = text.match(/https?:\/\/[^\s<>()"']+/gi) ?? [];
    if (urls.some((u) => bare(u.replace(/[.,;:!]+$/, '')) === want)) return true;
  }
  return new RegExp(`(^|[^\\w/#-])${escape(ticket.ref)}(?![\\w-])`, 'i').test(text);
}

/** The listed tickets a text names, in list order. */
export const ticketsNamed = (text: string, tickets: readonly Ticket[]): Ticket[] => tickets.filter((t) => namesTicket(text, t));

/** The session (other than this one and its workstream's) a ticket is under way in, or null. */
function underWayElsewhere(key: string, at: MentionSituation): string | null {
  const mine = new Set([at.sessionId, ...(at.workstreams.find((w) => w.sessionIds.includes(at.sessionId))?.sessionIds ?? [])]);
  for (const link of at.links) {
    if (link.ticketKey !== key) continue;
    const sessions = link.attachedTo === 'session' ? [link.id] : (at.workstreams.find((w) => w.id === link.id)?.sessionIds ?? []);
    const other = sessions.find((id) => !mine.has(id) && at.liveSessions.has(id));
    if (other) return other;
  }
  return null;
}

/** What the user's message does: nothing, keep, attach one, name where it is under way, or offer a pick. Pure. */
export function ticketMention(text: string, at: MentionSituation): MentionVerdict {
  const named = ticketsNamed(text, at.tickets);
  if (named.length === 0) return { type: 'none' };
  if (ticketOf(at.sessionId, at.links, at.workstreams)) return { type: 'keeps' };
  if (named.length > 1) return { type: 'several', tickets: named };
  const ticket = named[0]!;
  const elsewhere = underWayElsewhere(ticket.key, at);
  return elsewhere ? { type: 'elsewhere', ticket, sessionId: elsewhere } : { type: 'attach', ticket };
}
