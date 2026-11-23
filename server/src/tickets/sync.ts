// Keeps the ticket store (store.ts) current while a window is connected: every source is asked
// every TICKET_POLL_MS, and at once when the set of sources changes (a project added on a new
// GitLab server, Jira connected). A ticket's description and comments are asked for when its page
// opens (`read`), and again on the next round while it is held. The server is loopback only, so a
// tracker cannot tell it anything: it asks. While tickets are off (`ticketsOn`) it asks nothing, and a
// source switched off in Settings → Tickets (`ticketSourceOn`) is never asked.
// A ticket that left a source's list in a ready answer is asked about on its own (`status`): done, it is
// held in Closed; anything else, it was reassigned. A failed ask decides nothing and is asked again
// after the next ready answer.
import { reasonOf, unavailable } from '../shared/sourced.ts';
import { TICKETS_OFF_REASON, ticketSourceOn, ticketsOn } from '../shared/tickets.ts';
import type { TicketSource } from './source.ts';
import type { Ticket } from '../shared/tickets.ts';
import type { TicketStore } from './store.ts';

export const TICKET_POLL_MS = 120_000;
export const TICKET_CHECK_MS = 5_000;

export interface TicketSync {
  /** Ask every source now, and wait for it. */
  check(): Promise<void>;
  tick(): Promise<void>;
  /** Ask the ticket's source for its description and comments, and hold the answer. */
  read(key: string): Promise<void>;
  /** The source a ticket is from, while tickets and that source are on; else null. */
  sourceOf(ticket: Ticket): Promise<TicketSource | null>;
  stop(): void;
}

export function syncTickets(allSources: () => Promise<readonly TicketSource[]>, store: TicketStore, watched: () => boolean, now: () => number = Date.now, timers = true): TicketSync {
  let askedAt: number | null = null;
  let askedFor = '';
  let running: Promise<void> | null = null;
  let held: readonly TicketSource[] = [];
  const sources = async (): Promise<TicketSource[]> => (await allSources()).filter((s) => ticketSourceOn(store.view().settings, s.kind));

  const ask = async (list: readonly TicketSource[]): Promise<void> => {
    held = list;
    store.keep(list.map((s) => s.kind));
    const at = Date.now();
    await Promise.all(
      list.map(async (source) => {
        const answer = await source.assignedToMe().catch((error: unknown) => unavailable(reasonOf(error)));
        store.set(source.kind, answer, at);
        if (answer.state === 'ready') await settleLeaving(source);
      }),
    );
    // Details already asked for are kept current with the list; those of tickets no longer held go.
    store.forgetDetails();
    const keys = Object.keys(store.view().details);
    await Promise.all(keys.map((key) => read(key)));
  };

  /** Ask the tracker about each ticket that left this source's list: closed, or reassigned. */
  const settleLeaving = async (source: TicketSource): Promise<void> => {
    await Promise.all(
      store.leavingOf(source.kind).map(async (ticket) => {
        const answer = await source.status(ticket).catch((error: unknown) => unavailable(reasonOf(error)));
        if (answer.state !== 'ready') return; // decided by a later round
        if (answer.value.category === 'done') store.closedFound(ticket.key, answer.value, now());
        else store.stillOpen(ticket.key, answer.value);
      }),
    );
  };

  /** Sources that changed while a round was running (one connected, one switched on) are asked as soon as it ends. */
  let again: readonly TicketSource[] | null = null;
  const run = (list: readonly TicketSource[]): Promise<void> => {
    const kinds = list.map((s) => s.kind).join('\n');
    if (running) {
      if (kinds !== askedFor) again = list;
      return running;
    }
    askedAt = now();
    askedFor = kinds;
    running = ask(list)
      .catch((error: unknown) => console.error('[kestrel] could not check tickets', error))
      .finally(() => {
        running = null;
        const next = again;
        again = null;
        if (next) void run(next);
      });
    return running;
  };

  const tick = async (): Promise<void> => {
    if (running || !watched() || !ticketsOn(store.view())) return;
    const list = await sources();
    if (askedAt !== null && now() - askedAt < TICKET_POLL_MS && list.map((s) => s.kind).join('\n') === askedFor) return;
    await run(list);
  };

  const sourceOf = async (ticket: Ticket): Promise<TicketSource | null> => {
    if (!ticketSourceOn(store.view().settings, ticket.source)) return null;
    return held.find((s) => s.kind === ticket.source) ?? (await sources()).find((s) => s.kind === ticket.source) ?? null;
  };

  const read = async (key: string): Promise<void> => {
    if (!ticketsOn(store.view())) return store.setDetail(key, unavailable(TICKETS_OFF_REASON));
    const ticket = store.ticket(key);
    if (ticket && !ticketSourceOn(store.view().settings, ticket.source)) return store.setDetail(key, unavailable('This ticket’s tracker is switched off in Settings → Tickets.'));
    const source = ticket && (held.find((s) => s.kind === ticket.source) ?? (await sources()).find((s) => s.kind === ticket.source));
    if (!ticket) return; // not a ticket Kestrel holds: nothing to keep a detail for
    if (!source) return store.setDetail(key, unavailable('This ticket’s tracker is not connected now.'));
    store.loading(key);
    store.setDetail(key, await source.read(ticket).catch((error: unknown) => unavailable(reasonOf(error))));
  };

  const timer = timers ? setInterval(() => void tick().catch((error: unknown) => console.error('[kestrel] could not check tickets', error)), TICKET_CHECK_MS) : null;
  if (timers) void tick();

  return {
    sourceOf,
    // Never rejects: it is called without waiting, from a setting or a connection changing.
    check: async () => {
      try {
        if (ticketsOn(store.view())) await run(await sources());
      } catch (error) {
        console.error('[kestrel] could not check tickets', error);
      }
    },
    tick,
    read,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
