// A session's ticket, for the `ticket` suggestion and the `ticket_read` and `ticket_update` tools
// (docs/designs/tickets.md, section 7). Which ticket a session has is the one rule `ticketOf` (its own
// link, else its workstream's); a change is made through `moveTicket` or the ticket's source, never
// another way. Built by index.ts once the store and the sync exist, and handed to the runtime.
import { Refused } from '../refused.ts';
import { reasonOf } from '../shared/sourced.ts';
import type { TicketChange } from '../shared/ticket-changes.ts';
import { ticketOf, ticketsOn, TICKETS_OFF_REASON, type Ticket } from '../shared/tickets.ts';
import type { Workstream } from '../model.ts';
import { ticketBrief, ticketText } from './brief.ts';
import type { MentionSituation } from '../shared/ticket-mention.ts';
import { commentOnTicket } from './comment.ts';
import { moveTicket, type TicketMoved } from './move.ts';
import type { TicketStore } from './store.ts';
import type { TicketSync } from './sync.ts';

export interface SessionTickets {
  /** The session's ticket, or why it has none Kestrel can change: tickets off, none attached, its tracker not connected. */
  ticketOf(sessionId: string): Promise<Ticket | { reason: string }>;
  /** The ticket as the tracker has it now, for `ticket_read`: the session's own, or one Kestrel lists named by its key. Read only. Throws a `Refused` saying why there is none. */
  read(sessionId: string, key?: string): Promise<string>;
  moveTo(key: string, category: Exclude<TicketChange, 'comment'>): Promise<TicketMoved>;
  moveBack(key: string, to: string): Promise<TicketMoved>;
  comment(key: string, body: string): Promise<void>;
  /** What a user's message is matched against (shared/ticket-mention.ts); null while tickets are off. */
  situation(sessionId: string | null): Promise<MentionSituation | null>;
  /** The ticket's first message for an agent: the ticket as the tracker has it, then the standing brief. */
  brief(key: string): Promise<string>;
  /** Take the ticket up in this session, as Work this ticket does: attached (to its workstream when it has one) and tagged with the key. */
  attach(sessionId: string, key: string): Promise<Ticket>;
  /** Undo of `attach`: the ticket comes off and the tag goes. A status move made meanwhile stays. */
  detach(sessionId: string, key: string): Promise<void>;
}

/** What a runtime without tickets says (tests, the story scenes). */
export const NO_SESSION_TICKETS: SessionTickets = {
  ticketOf: async () => ({ reason: 'Tickets are not available here.' }),
  read: async () => {
    throw new Refused('Tickets are not available here.');
  },
  moveTo: async () => {
    throw new Refused('Tickets are not available here.');
  },
  moveBack: async () => {
    throw new Refused('Tickets are not available here.');
  },
  comment: async () => {
    throw new Refused('Tickets are not available here.');
  },
  situation: async () => null,
  brief: async () => {
    throw new Refused('Tickets are not available here.');
  },
  attach: async () => {
    throw new Refused('Tickets are not available here.');
  },
  detach: async () => undefined,
};

export interface SessionTicketsDeps {
  store: TicketStore;
  sync: Pick<TicketSync, 'read' | 'sourceOf'>;
  workstreams(): Promise<readonly Pick<Workstream, 'id' | 'sessionIds'>[]>;
  /** Sessions that exist and are not archived. */
  liveSessions(): Promise<ReadonlySet<string>>;
  tag(sessionId: string, tag: string): Promise<unknown>;
  untag(sessionId: string, tag: string): Promise<unknown>;
  now?: () => number;
}

/** How long a user's message that names a ticket waits for the ticket's description. */
export const BRIEF_WAIT_MS = 3_000;

const CATEGORY_WORDS = { 'in-progress': 'In progress', 'in-review': 'In review' } as const;

export function sessionTickets(deps: SessionTicketsDeps): SessionTickets {
  const { store, sync } = deps;
  const attached = async (sessionId: string): Promise<Ticket | { reason: string }> => {
    if (!ticketsOn(store.view())) return { reason: TICKETS_OFF_REASON };
    const link = ticketOf(sessionId, store.view().links, await deps.workstreams());
    const ticket = link && store.ticket(link.ticketKey);
    if (!ticket) return { reason: 'This session has no ticket. A ticket is attached by Work this ticket, or when the user names one in a message.' };
    return ticket;
  };
  /** A ticket Kestrel lists, named by its key as the tracker shows it (PLAT-12) or as Kestrel keeps it. */
  const named = (key: string): Ticket => {
    if (!ticketsOn(store.view())) throw new Refused(TICKETS_OFF_REASON);
    const want = key.trim().toLowerCase();
    if (!want) throw new Refused('Name the ticket by its key, like PLAT-12.');
    const found = store.view().tickets.filter((t) => t.key.toLowerCase() === want || t.ref.toLowerCase() === want);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) throw new Refused(`${key} names more than one listed ticket (${found.map((t) => `${t.tracker} ${t.ref}`).join(', ')}); give the full key: ${found.map((t) => t.key).join(' or ')}.`);
    throw new Refused(`Kestrel does not list ${key}. It holds only the open tickets assigned to the user, from the trackers switched on in Settings → Tickets; ask the user for what you need from any other.`);
  };
  const sourceFor = async (key: string) => {
    const ticket = store.ticket(key);
    if (!ticket) throw new Refused('Kestrel does not hold that ticket.');
    const source = await sync.sourceOf(ticket);
    if (!source) throw new Refused(`${ticket.ref}’s tracker is not connected or is switched off in Settings → Tickets.`);
    return { ticket, source };
  };
  return {
    async ticketOf(sessionId) {
      const ticket = await attached(sessionId);
      if ('reason' in ticket) return ticket;
      return (await sync.sourceOf(ticket)) ? ticket : { reason: `${ticket.ref}’s tracker is not connected or is switched off in Settings → Tickets.` };
    },
    async read(sessionId, key) {
      const ticket = key === undefined ? await attached(sessionId) : named(key);
      if ('reason' in ticket) throw new Refused(ticket.reason);
      await sync.read(ticket.key).catch(() => undefined);
      const held = store.view().details[ticket.key];
      return ticketText(store.ticket(ticket.key) ?? ticket, held?.state === 'ready' ? held.value : null);
    },
    async moveTo(key, category) {
      const { ticket, source } = await sourceFor(key);
      const offered = await source.statuses(ticket);
      if (offered.state !== 'ready') throw new Refused(`${ticket.tracker} could not say where ${ticket.ref} can move: ${offered.state === 'unavailable' ? offered.reason : 'it is still loading'}`);
      const target = offered.value.find((s) => s.category === category);
      if (!target) throw new Refused(`${ticket.tracker} offers no ${CATEGORY_WORDS[category]} status that ${ticket.ref} can move to now.`);
      return moveTicket({ store, sourceOf: sync.sourceOf }, key, target.name);
    },
    moveBack: (key, to) => moveTicket({ store, sourceOf: sync.sourceOf }, key, to),
    async comment(key, body) {
      await commentOnTicket({ store, sourceOf: sync.sourceOf, read: sync.read }, key, body);
    },
    async situation(sessionId) {
      const view = store.view();
      if (!ticketsOn(view)) return null;
      return { sessionId: sessionId ?? '', tickets: view.tickets, links: view.links, workstreams: await deps.workstreams(), liveSessions: await deps.liveSessions() };
    },
    async brief(key) {
      const ticket = store.ticket(key);
      if (!ticket) throw new Refused('Kestrel does not hold that ticket.');
      // The user's message waits on this: a tracker slower than BRIEF_WAIT_MS leaves the agent the link instead.
      if (store.view().details[key]?.state !== 'ready') await Promise.race([sync.read(key).catch(() => undefined), new Promise((r) => setTimeout(r, BRIEF_WAIT_MS))]);
      const held = store.view().details[key];
      return ticketBrief(store.ticket(key) ?? ticket, held?.state === 'ready' ? held.value : null);
    },
    async attach(sessionId, key) {
      if (!ticketsOn(store.view())) throw new Refused(TICKETS_OFF_REASON);
      const ticket = store.ticket(key);
      if (!ticket) throw new Refused('Kestrel does not hold that ticket.');
      const streams = await deps.workstreams();
      const has = ticketOf(sessionId, store.view().links, streams);
      if (has && has.ticketKey !== key) throw new Refused(`This session already works on ${store.ticket(has.ticketKey)?.ref ?? 'another ticket'}; a session has one ticket. Undo that one first.`);
      const stream = streams.find((w) => w.sessionIds.includes(sessionId));
      store.attach({ ticketKey: key, attachedTo: stream ? 'workstream' : 'session', id: stream?.id ?? sessionId, role: 'lead', at: (deps.now ?? Date.now)() });
      await deps.tag(sessionId, ticket.ref).catch((error: unknown) => console.error('[kestrel] could not tag the ticket’s session', error));
      return ticket;
    },
    async detach(sessionId, key) {
      const ticket = store.ticket(key);
      const stream = (await deps.workstreams()).find((w) => w.sessionIds.includes(sessionId));
      const link = store.view().links.find((l) => l.ticketKey === key && ((l.attachedTo === 'session' && l.id === sessionId) || (stream && l.attachedTo === 'workstream' && l.id === stream.id)));
      if (link) store.detach(link.attachedTo, link.id);
      if (ticket) await deps.untag(sessionId, ticket.ref).catch(() => undefined);
    },
  };
}
