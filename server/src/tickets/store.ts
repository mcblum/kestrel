// The one copy, on the server, of the user's tickets (docs/designs/tickets.md, section 4). Held per
// source, kept current in the background (sync.ts) and pushed whole to every window's `tickets`
// slice: no view asks a tracker. A source that cannot answer keeps its last list and gains a
// problem, so a failed ask never empties the list. Listeners hear only when the view really changed.
// Dismissed and read keys are kept as the review requests' are. A ticket attached to work (a
// `TicketLink`) stays held after it leaves the assigned list, at its last known state, so the work
// still shows what it is for.
// Closed tickets (section 4a): a ticket that leaves a source's list in a ready answer is `leaving`
// until the sync asks its tracker for that one ticket's status (`leavingOf`, then `closedFound` or
// `stillOpen`). Done, it is held apart in `closed`; anything else, it was reassigned and goes. The last
// ready list of every source is saved (`held`), so a ticket that closes while Kestrel is not running
// is found on the first answer after it starts. Kestrel never asks a tracker for old closed tickets.
import { findTicket, keptClosed, NO_TICKET_SETTINGS, orderTickets, ticketSourceOn, type ClosedTicket, type Ticket, type TicketMove, type TicketSettings, type TicketDetail, type TicketLink, type TicketsView } from '../shared/tickets.ts';
import { LOADING, type Sourced } from '../shared/sourced.ts';
import { withDismissed } from '../shared/review-requests.ts';

interface SourceEntry {
  tickets: readonly Ticket[];
  problem: string | null;
}

export type TicketListener = (view: TicketsView) => void;

export interface TicketStoreOptions {
  dismissed?: readonly string[];
  saveDismissed?: (keys: readonly string[]) => void;
  seen?: readonly string[];
  saveSeen?: (keys: readonly string[]) => void;
  links?: readonly TicketLink[];
  saveLinks?: (links: readonly TicketLink[]) => void;
  settings?: TicketSettings;
  saveSettings?: (settings: TicketSettings) => void;
  /** The tickets in each source's last ready list, and those leaving it, as saved. */
  held?: readonly Ticket[];
  saveHeld?: (tickets: readonly Ticket[]) => void;
  closed?: readonly ClosedTicket[];
  saveClosed?: (closed: readonly ClosedTicket[]) => void;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class TicketStore {
  private dismissedKeys: readonly string[];
  private seenKeys: readonly string[];
  private links: readonly TicketLink[];
  private settings: TicketSettings;
  private sources: ReadonlyMap<string, SourceEntry> = new Map();
  /** The last state of every ticket ever listed, so an attached one outlives the list. */
  private known: ReadonlyMap<string, Ticket> = new Map();
  /** Moves made here, by ticket, with when: kept until an answer asked after them arrives. */
  private moves: ReadonlyMap<string, { status: TicketMove; at: number }> = new Map();
  private details: ReadonlyMap<string, Sourced<TicketDetail>> = new Map();
  /** Each source's last ready list, kept when a source is no longer asked, so leaving it is noticed when it is asked again. */
  private listedBy: ReadonlyMap<string, readonly Ticket[]> = new Map();
  /** Tickets that left their source's list and whose tracker has not yet said whether they closed. */
  private leaving: ReadonlyMap<string, Ticket> = new Map();
  private closedTickets: readonly ClosedTicket[];
  private heldJson = '';
  private current: TicketsView;
  private json = '';
  private readonly listeners = new Set<TicketListener>();

  constructor(private readonly options: TicketStoreOptions = {}) {
    this.dismissedKeys = options.dismissed ?? [];
    this.seenKeys = options.seen ?? [];
    this.links = options.links ?? [];
    this.settings = options.settings ?? NO_TICKET_SETTINGS;
    this.closedTickets = keptClosed(options.closed ?? []);
    const bySource = new Map<string, Ticket[]>();
    for (const t of options.held ?? []) bySource.set(t.source, [...(bySource.get(t.source) ?? []), t]);
    this.listedBy = bySource;
    this.known = new Map([...(options.held ?? []), ...this.closedTickets].map((t) => [t.key, t]));
    this.heldJson = JSON.stringify(this.heldList());
    this.current = this.build();
    this.json = JSON.stringify(this.current);
  }

  view(): TicketsView {
    return this.current;
  }

  /** Any ticket held: listed, dismissed or attached. */
  ticket(key: string): Ticket | undefined {
    return this.known.get(key);
  }

  /**
   * A source's answer. One that could not be given keeps the source's last list and records why.
   * `askedAt`: when it was asked; a ticket moved here after that keeps its new status, so an answer
   * already on its way does not undo the user's move.
   */
  set(kind: string, answer: Sourced<Ticket[]>, askedAt?: number): void {
    if (answer.state === 'loading') return;
    const held = this.sources.get(kind);
    if (answer.state === 'ready') answer = { ...answer, value: answer.value.map((t) => this.withMove(t, askedAt)) };
    const entry: SourceEntry = answer.state === 'ready' ? { tickets: answer.value, problem: null } : { tickets: held?.tickets ?? [], problem: answer.reason };
    if (answer.state === 'ready') {
      const known = new Map(this.known);
      for (const t of answer.value) known.set(t.key, t);
      this.known = known;
      this.noteLeaving(kind, answer.value);
    }
    this.replace(new Map(this.sources).set(kind, entry));
  }

  /**
   * A source's ready list against its last one: what left it is leaving, what is back is no longer
   * leaving or closed (reopened). A closed ticket whose status was moved out of done here is asked about
   * again, so a ticket reopened for someone else goes.
   */
  private noteLeaving(kind: string, listed: readonly Ticket[]): void {
    const now = new Set(listed.map((t) => t.key));
    const leaving = new Map([...this.leaving].filter(([key]) => !now.has(key)));
    for (const t of this.listedBy.get(kind) ?? []) if (!now.has(t.key)) leaving.set(t.key, this.known.get(t.key) ?? t);
    for (const t of this.closedTickets) if (t.source === kind && t.status.category !== 'done' && !now.has(t.key)) leaving.set(t.key, t);
    this.leaving = leaving;
    this.listedBy = new Map(this.listedBy).set(kind, listed);
    // Back in the list is reopened, except a ticket marked done here that its tracker still lists as done.
    const listedDone = new Set(listed.filter((t) => t.status.category === 'done').map((t) => t.key));
    const closed = this.closedTickets.filter((t) => !now.has(t.key) || (t.doneHere === true && listedDone.has(t.key)));
    if (closed.length !== this.closedTickets.length) this.keepClosed(closed);
    this.saveHeld();
  }

  /** The tickets that left this source's list and wait for their tracker to say whether they closed. */
  leavingOf(kind: string): Ticket[] {
    return [...this.leaving.values()].filter((t) => t.source === kind);
  }

  /** The tracker says a leaving ticket is done: it is held in Closed, from `at` (or from when it first closed, if it was already there). */
  closedFound(key: string, status: TicketMove, at: number): void {
    const ticket = this.leaving.get(key);
    if (!ticket) return;
    this.leaving = new Map([...this.leaving].filter(([k]) => k !== key));
    const was = this.closedTickets.find((t) => t.key === key);
    const closed: ClosedTicket = { ...ticket, status, closedAt: was?.closedAt ?? at, ...(was?.doneHere ? { doneHere: true as const } : {}) };
    this.known = new Map(this.known).set(key, closed);
    this.keepClosed([closed, ...this.closedTickets.filter((t) => t.key !== key)]);
    this.saveHeld();
    this.replace(this.sources);
  }

  /** The tracker says a leaving ticket is not done: it was reassigned (or reopened for someone else), and is no longer listed or closed. */
  stillOpen(key: string, status: TicketMove): void {
    const ticket = this.leaving.get(key);
    if (!ticket) return;
    this.leaving = new Map([...this.leaving].filter(([k]) => k !== key));
    this.known = new Map(this.known).set(key, { ...ticket, status });
    this.keepClosed(this.closedTickets.filter((t) => t.key !== key));
    this.saveHeld();
    this.replace(this.sources);
  }

  private keepClosed(next: readonly ClosedTicket[]): void {
    this.closedTickets = keptClosed(next);
    this.options.saveClosed?.(this.closedTickets);
  }

  private heldList(): Ticket[] {
    return [...[...this.listedBy.values()].flat(), ...[...this.leaving.values()].filter((t) => !this.closedTickets.some((c) => c.key === t.key))];
  }

  private saveHeld(): void {
    const list = this.heldList();
    const json = JSON.stringify(list);
    if (json === this.heldJson) return;
    this.heldJson = json;
    this.options.saveHeld?.(list);
  }

  /** Only these sources are still asked: what the others answered is dropped from the list. */
  keep(kinds: readonly string[]): void {
    const kept = new Set(kinds);
    this.replace(new Map([...this.sources].filter(([kind]) => kept.has(kind))));
  }

  /** Settings → Tickets. Off, or a source off, its tickets leave the list; attached ones stay held, for their chips. */
  setSettings(next: TicketSettings): void {
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.settings = next;
    this.options.saveSettings?.(next);
    this.replace(this.sources);
  }

  dismiss(keys: readonly string[], on: boolean): void {
    const next = withDismissed(this.dismissedKeys, keys, on);
    if (sameList(next, this.dismissedKeys)) return;
    this.dismissedKeys = next;
    this.options.saveDismissed?.(next);
    if (on) this.keepSeen(withDismissed(this.seenKeys, keys, true));
    this.replace(this.sources);
  }

  markSeen(keys: readonly string[], seen: boolean): void {
    if (this.keepSeen(withDismissed(this.seenKeys, keys, seen))) this.replace(this.sources);
  }

  private keepSeen(next: readonly string[]): boolean {
    if (sameList(next, this.seenKeys)) return false;
    this.seenKeys = next;
    this.options.saveSeen?.(next);
    return true;
  }

  /** Attach a ticket to a session or workstream. Each has at most one ticket: a new one replaces the old. */
  attach(link: TicketLink): void {
    this.links = [...this.links.filter((l) => !(l.attachedTo === link.attachedTo && l.id === link.id)), link];
    this.options.saveLinks?.(this.links);
    this.keepSeen(withDismissed(this.seenKeys, [link.ticketKey], true));
    this.replace(this.sources);
  }

  /** Take the ticket off a session or workstream. */
  detach(attachedTo: TicketLink['attachedTo'], id: string): void {
    const next = this.links.filter((l) => !(l.attachedTo === attachedTo && l.id === id));
    if (next.length === this.links.length) return;
    this.links = next;
    this.options.saveLinks?.(next);
    this.replace(this.sources);
  }

  /** A ticket's new status after a move: held at once, in its source's list and in what is known. */
  setStatus(key: string, status: TicketMove, at: number = Date.now()): void {
    const held = this.known.get(key);
    if (!held) return;
    this.moves = new Map(this.moves).set(key, { status, at });
    const moved = { ...held, status };
    this.known = new Map(this.known).set(key, moved);
    const swap = <T extends Ticket>(t: T): T => (t.key === key ? { ...t, status } : t);
    this.listedBy = new Map([...this.listedBy].map(([kind, list]) => [kind, list.map(swap)]));
    if (this.leaving.has(key)) this.leaving = new Map(this.leaving).set(key, moved);
    // Marked done here: it is in Done at once. Moved out of done: it is no longer one the user marked done.
    const was = this.closedTickets.find((t) => t.key === key);
    const others = this.closedTickets.filter((t) => t.key !== key);
    if (status.category === 'done') this.keepClosed([{ ...moved, closedAt: was?.closedAt ?? at, doneHere: true }, ...others]);
    else if (was) this.keepClosed([{ ...held, status, closedAt: was.closedAt }, ...others]);
    this.saveHeld();
    const sources = new Map([...this.sources].map(([kind, entry]) => [kind, entry.tickets.some((t) => t.key === key) ? { ...entry, tickets: entry.tickets.map((t) => (t.key === key ? moved : t)) } : entry]));
    this.replace(sources);
  }

  /** A ticket as an answer has it, unless it was moved here after the answer was asked for. */
  private withMove(ticket: Ticket, askedAt: number | undefined): Ticket {
    const move = this.moves.get(ticket.key);
    if (!move) return ticket;
    if (askedAt !== undefined && askedAt < move.at) return { ...ticket, status: move.status };
    this.moves = new Map([...this.moves].filter(([k]) => k !== ticket.key)); // an answer asked after the move is the tracker's word now
    return ticket;
  }

  /** Details of tickets no longer held are dropped, so each round reads only what can still be shown. */
  forgetDetails(): void {
    const kept = new Map([...this.details].filter(([key]) => findTicket(this.current, key) !== undefined));
    if (kept.size === this.details.size) return;
    this.details = kept;
    this.replace(this.sources);
  }

  /** Say a ticket's detail is being asked for: a page shows Loading only the first time. */
  loading(key: string): void {
    if (this.details.has(key)) return;
    this.details = new Map(this.details).set(key, LOADING);
    this.replace(this.sources);
  }

  /** A ticket's description and comments. A failed ask keeps an earlier answer. */
  setDetail(key: string, detail: Sourced<TicketDetail>): void {
    const held = this.details.get(key);
    if (detail.state === 'unavailable' && held?.state === 'ready') return;
    this.details = new Map(this.details).set(key, detail);
    this.replace(this.sources);
  }

  onChange(listener: TicketListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private build(): TicketsView {
    const kinds = [...this.sources.keys()].sort();
    const on = this.settings.on;
    const used = kinds.filter((kind) => ticketSourceOn(this.settings, kind));
    const listed = used.flatMap((kind) => this.sources.get(kind)!.tickets);
    const listedKeys = new Set(listed.map((t) => t.key));
    const gone = new Set(this.dismissedKeys);
    const seen = new Set(this.seenKeys);
    const usedKinds = new Set(used);
    // A ticket marked done here shows as done even while its tracker still lists it.
    const doneKeys = new Set(this.closedTickets.filter((t) => t.doneHere).map((t) => t.key));
    const closed = on ? this.closedTickets.filter((t) => usedKinds.has(t.source) && (t.doneHere === true || !listedKeys.has(t.key))) : [];
    const closedKeys = new Set(closed.map((t) => t.key));
    const attachedKeys = [...new Set(this.links.map((l) => l.ticketKey))].filter((key) => !listedKeys.has(key) && !closedKeys.has(key));
    return {
      tickets: orderTickets(listed.filter((t) => !gone.has(t.key) && !doneKeys.has(t.key))),
      unread: listed.filter((t) => !gone.has(t.key) && !doneKeys.has(t.key) && !seen.has(t.key)).map((t) => t.key).sort(),
      dismissed: orderTickets(listed.filter((t) => gone.has(t.key) && !doneKeys.has(t.key))),
      closed,
      attached: attachedKeys.flatMap((key) => this.known.get(key) ?? []),
      links: [...this.links],
      details: Object.fromEntries(this.details),
      problems: used.flatMap((kind) => (this.sources.get(kind)!.problem ? [{ source: kind, reason: this.sources.get(kind)!.problem! }] : [])),
      sources: on ? used : [],
      settings: this.settings,
    };
  }

  private replace(sources: ReadonlyMap<string, SourceEntry>): void {
    this.sources = sources;
    const view = this.build();
    const json = JSON.stringify(view);
    if (json === this.json) return;
    this.current = view;
    this.json = json;
    for (const listener of this.listeners) listener(view);
  }
}
