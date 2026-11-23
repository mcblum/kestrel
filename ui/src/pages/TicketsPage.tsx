// Tickets: the open tickets assigned to the user in the trackers Kestrel can ask, as the server pushes
// them (`tickets`), built as the Code reviews page is and sharing its parts. The ones in the user's
// current sprint come first under the sprint's name, then the rest (`ticketOrder`, the one order).
// The view is kept in the tab's path: Waiting, Dismissed, Done, or Closed. In Waiting, tickets with
// active work get their own section above the sprint groups. Filters and sort apply to both sections.
// Bulk dismiss and mark read apply to the filtered queue. Dismissing posts nothing to the tracker.
import { memo, useMemo, useState } from 'react';
import { CheckCheck, CircleCheck, RefreshCw, RotateCcw, X } from 'lucide-react';
import { CATEGORY_LABEL, choicesOf, filterTickets, isFilteringTickets, NO_TICKET_FILTERS, DEFAULT_TICKET_SORT, closedElsewhere, doneHere, orderTickets, sortTickets, ticketOrder, TICKET_SORT_BY, TICKET_SORT_LABEL, ticketSortDirectionLabel, TICKET_CATEGORIES, ticketsUnderWay, type ClosedTicket, type Ticket, type TicketFilters, type TicketSort, ticketsOn } from '@kestrel/server/tickets';
import { splitStarted } from '@kestrel/server/review-filter';
import { agoText } from '@kestrel/server/when';
import { statusText } from '../labels.ts';
import { useRowDot } from '../components/useRowDot.ts';
import { openSession, openView, opener, showLocal } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { useMinuteNow } from '../useNow.ts';
import { ticketLeadIn, workTicket } from '../tickets.ts';
import { InboxReference, InboxSearch, InboxStartButton } from '../components/InboxList.tsx';
import { TicketStatus } from '../components/TicketStatus.tsx';
import { TicketActionsMenu } from '../components/TicketActionsMenu.tsx';
import { openRowMenu } from '../components/sidebarMenuTarget.ts';
import { PageHeader } from './PageHeader.tsx';

/** The lead session working on a ticket, if one is. */
function useLead(key: string) {
  const id = useApp((s) => ticketLeadIn(s, key));
  return useApp((s) => (id ? s.workspace?.sessions.find((x) => x.id === id) : undefined));
}

function TicketMetadata({ ticket, time }: { ticket: Ticket; time: string }) {
  return (
    <span className="inbox-meta">
      <InboxReference service={ticket.tracker}>{ticket.ref}</InboxReference>
      {ticket.project && <span>{ticket.project}</span>}
      {ticket.priorityName && <span title={`${ticket.priorityName} priority`}>{ticket.priorityName}</span>}
      {time && <span>{time}</span>}
    </span>
  );
}

const TicketRow = memo(function TicketRow({ ticket, dismissed, underWay = false }: { ticket: Ticket; dismissed: boolean; underWay?: boolean }) {
  const now = useMinuteNow();
  const unread = useApp((s) => !dismissed && s.tickets.unread.includes(ticket.key));
  const lead = useLead(ticket.key);
  const dot = useRowDot(dismissed ? undefined : lead);
  const news = dot.className === 'green' || dot.className === 'amber';
  const leadStatus = lead ? `Lead: ${statusText(lead).toLowerCase()}` : '';
  return (
    <li
      className={`inbox-row${unread || news ? ' unread' : ''}`}
      // Right-click: the ticket's own menu, the one its … and its sidebar row open (menu.ts).
      onContextMenu={(event) => {
        event.preventDefault();
        openRowMenu('ticket', ticket.key, { x: event.clientX, y: event.clientY });
      }}
    >
      <span className="inbox-indicator">
        {dot.className !== 'none' ? (
          <span className={`status-dot ${dot.className}`} role="img" aria-label={dot.label} title={dot.label} />
        ) : unread ? (
          <span className="status-dot green" role="img" aria-label="New ticket" title="New ticket" />
        ) : null}
      </span>
      <button
        type="button"
        className="inbox-open"
        title={lead ? `Open lead session for ${ticket.title}` : ticket.title}
        {...opener((newTab) => {
          if (unread) void actions.markTicketsSeen([ticket.key], true);
          if (lead) openSession(lead.id, newTab);
          else openView({ kind: 'ticket', id: ticket.key }, newTab);
        })}
      >
        <span className="inbox-title">{ticket.title}</span>
        <TicketMetadata ticket={ticket} time={ticket.updatedAt ? `Updated ${agoText(ticket.updatedAt, now)}` : ''} />
      </button>
      <span className="inbox-status">
        {!dismissed && !underWay && !lead && <InboxStartButton label="Start work" reference={ticket.ref} onStart={(newTab) => workTicket(ticket.key, newTab)} />}
        {lead && <span className="inbox-status-note" title={leadStatus}>{leadStatus}</span>}
        <TicketStatus ticket={ticket} />
      </span>
      <TicketActionsMenu ticket={ticket} />
    </li>
  );
});

/** A closed ticket: when it closed, its last status as the control that can reopen it, and its page. */
const ClosedRow = memo(function ClosedRow({ ticket }: { ticket: ClosedTicket }) {
  const now = useMinuteNow();
  return (
    <li
      className="inbox-row"
      onContextMenu={(event) => {
        event.preventDefault();
        openRowMenu('ticket', ticket.key, { x: event.clientX, y: event.clientY });
      }}
    >
      <span className="inbox-indicator"><CircleCheck aria-hidden /></span>
      <button type="button" className="inbox-open" title={ticket.title} {...opener((newTab) => openView({ kind: 'ticket', id: ticket.key }, newTab))}>
        <span className="inbox-title">{ticket.title}</span>
        <TicketMetadata ticket={ticket} time={`${ticket.doneHere ? 'Marked done' : 'Closed'} ${agoText(ticket.closedAt, now)}`} />
      </button>
      <span className="inbox-status"><TicketStatus ticket={ticket} /></span>
      <TicketActionsMenu ticket={ticket} />
    </li>
  );
});

function Pick({ label, any, value, choices, onChange }: { label: string; any: string; value: string; choices: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  if (choices.length < 2 && !value) return null;
  return (
    <select aria-label={label} className={`form-control inbox-pick${value ? ' set' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{any}</option>
      {value && !choices.some((choice) => choice.value === value) && <option value={value}>{value}</option>}
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

const plainChoices = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

function Empty({ which, sources }: { which: TicketList; sources: readonly string[] }) {
  if (which === 'done')
    return (
      <div className="empty">
        <h2>Nothing marked done yet</h2>
        <p>A ticket you move to a done status from Kestrel is kept here. Tickets you finished before are not loaded.</p>
      </div>
    );
  if (which === 'closed')
    return (
      <div className="empty">
        <h2>No ticket has closed yet</h2>
        <p>When a ticket Kestrel listed is closed in its tracker, it moves here. Older closed tickets are not loaded.</p>
      </div>
    );
  if (which === 'dismissed')
    return (
      <div className="empty">
        <h2>Nothing dismissed</h2>
        <p>A ticket you dismiss is kept here while its tracker still lists it, so it can be restored.</p>
      </div>
    );
  return (
    <div className="empty">
      <h2>No ticket is assigned to you</h2>
      <p>
        {sources.length > 0
          ? 'Open tickets assigned to you show here, from the sources switched on in Settings → Tickets.'
          : 'No source is on. GitLab and GitHub issues need only the sign-in glab and gh already have; Jira needs connecting.'}{' '}
        <button type="button" className="link-button" {...opener((newTab) => openView({ kind: 'settings', section: 'tickets' }, newTab))}>
          Choose sources in Settings → Tickets
        </button>
      </p>
    </div>
  );
}

/** While tickets are off (`ticketsOn`) the page says so and where to turn them on, rather than showing an empty list. */
function TicketsOff() {
  return (
    <div className="page column reviews-page">
      <PageHeader title="Tickets" line="Open tickets assigned to you, from GitLab, GitHub and Jira." />
      <div className="empty">
        <h2>Tickets are off</h2>
        <p>
          Kestrel asks no tracker while they are off.{' '}
          <button type="button" className="link-button" {...opener((newTab) => openView({ kind: 'settings', section: 'tickets' }, newTab))}>
            Turn them on in Settings → Tickets
          </button>
        </p>
      </div>
    </div>
  );
}

/** The lists available in the Tickets tab. */
export type TicketList = 'waiting' | 'dismissed' | 'done' | 'closed';

export function TicketsPage({ list }: { list: TicketList }) {
  const on = useApp((s) => ticketsOn(s.tickets));
  return on ? <TicketsList which={list} /> : <TicketsOff />;
}

/** How many tickets under way are listed before "Show all", as on Code reviews. */
const UNDER_WAY_SHOWN = 10;
const SORT_OPTIONS = TICKET_SORT_BY.flatMap((by) => [true, false].map((descending) => ({ by, descending })));

/** The keys of the tickets with work under way, from the workspace as held (`ticketsUnderWay`). */
function useUnderWay(): Set<string> {
  const links = useApp((s) => s.tickets.links);
  const sessions = useApp((s) => s.workspace?.sessions);
  const workstreams = useApp((s) => s.workspace?.workstreams);
  return useMemo(() => ticketsUnderWay(links, new Set((sessions ?? []).map((x) => x.id)), new Set((workstreams ?? []).map((w) => w.id))), [links, sessions, workstreams]);
}

function TicketsList({ which }: { which: TicketList }) {
  const dismissed = which === 'dismissed';
  // Done and Closed are both held closed tickets: the ones the user marked done here, and the rest.
  const closed = which === 'closed' || which === 'done';
  const view = useApp((s) => s.tickets);
  const [filters, setFilters] = useState<TicketFilters>(NO_TICKET_FILTERS);
  const [allUnderWay, setAllUnderWay] = useState(false);
  const [sort, setSort] = useState<TicketSort>(DEFAULT_TICKET_SORT);
  const underWayKeys = useUnderWay();
  const doneList = useMemo(() => doneHere(view.closed), [view.closed]);
  const closedList = useMemo(() => closedElsewhere(view.closed), [view.closed]);
  const heldClosed = which === 'done' ? doneList : closedList;
  const everything: readonly Ticket[] = closed ? heldClosed : dismissed ? view.dismissed : view.tickets;
  const split = useMemo(() => splitStarted(orderTickets(everything), which === 'waiting' ? underWayKeys : new Set<string>()), [everything, which, underWayKeys]);
  const started = useMemo(() => sortTickets(filterTickets(split.started, filters), sort), [split.started, filters, sort]);
  const underWay = allUnderWay ? started : started.slice(0, UNDER_WAY_SHOWN);
  const list = useMemo(() => filterTickets(split.rest, filters), [split.rest, filters]);
  // The sprint groups keep their places; the arrow orders the tickets inside each.
  // Closed tickets have no sprint to group by: one list in the chosen order.
  const groups = useMemo(() => (closed ? [{ sprint: null, tickets: sortTickets(list, sort) }] : ticketOrder(list).filter((g) => g.tickets.length > 0).map((g) => ({ ...g, tickets: sortTickets(g.tickets, sort) }))), [list, sort, closed]);
  const filtering = isFilteringTickets(filters);
  const matchCount = started.length + list.length;
  const shownUnread = useMemo(() => {
    const shown = new Set(list.map((t) => t.key));
    return which !== 'waiting' ? [] : view.unread.filter((key) => shown.has(key));
  }, [list, view.unread, which]);
  const [refreshing, setRefreshing] = useState(false);
  const chip = (label: string, count: number, on: boolean, filter?: 'dismissed' | 'done' | 'closed') => (
    <button type="button" className={`chip${on ? ' selected' : ''}`} aria-pressed={on} onClick={() => showLocal(filter ? { kind: 'tickets', filter } : { kind: 'tickets' })}>
      {label} <span className="chip-count">{count}</span>
    </button>
  );
  const allLabel = dismissed ? (filtering ? `Restore ${list.length} shown` : 'Restore all') : filtering ? `Dismiss ${list.length} shown` : split.started.length > 0 ? 'Dismiss all not started' : 'Dismiss all';
  return (
    <div className="page column inbox-page tickets-page">
      <PageHeader
        title="Tickets"
        line="Tickets assigned to you"
        actions={
          <>
            <button
              type="button"
              className="secondary-button small"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await actions.refreshTickets();
                setRefreshing(false);
              }}
            >
              <RefreshCw aria-hidden /> {refreshing ? 'Asking…' : 'Refresh'}
            </button>
            {shownUnread.length > 0 && (
              <button type="button" className="secondary-button small" onClick={() => void actions.markTicketsSeen(shownUnread, true, true)}>
                <CheckCheck aria-hidden /> {filtering || shownUnread.length !== view.unread.length ? `Mark ${shownUnread.length} read` : 'Mark all read'}
              </button>
            )}
            {list.length > 0 && !closed && (
              <button type="button" className="secondary-button small" onClick={() => void actions.dismissTickets(list.map((t) => t.key), !dismissed)}>
                {dismissed ? <RotateCcw aria-hidden /> : <X aria-hidden />} {allLabel}
              </button>
            )}
          </>
        }
      />
      <div className="inbox-controls">
        <div className="chips inbox-tabs" role="group" aria-label="Ticket view">
          {chip('Waiting', view.tickets.length, which === 'waiting')}
          {chip('Dismissed', view.dismissed.length, dismissed, 'dismissed')}
          {chip('Done', doneList.length, which === 'done', 'done')}
          {chip('Closed', closedList.length, which === 'closed', 'closed')}
        </div>
        {dismissed && <p className="inbox-view-note">Dismissed tickets are hidden from Waiting. Restore a ticket to bring it back.</p>}
        {everything.length > 0 && (
          <div className="inbox-toolbar" role="group" aria-label="Filter and sort tickets">
            <InboxSearch label="Search tickets" value={filters.text} onChange={(text) => setFilters({ ...filters, text })} />
            <Pick label="Tracker" any="Any tracker" value={filters.tracker} choices={plainChoices(choicesOf(everything, 'tracker'))} onChange={(tracker) => setFilters({ ...filters, tracker })} />
            <Pick label="Project" any="Any project" value={filters.project} choices={plainChoices(choicesOf(everything, 'project'))} onChange={(project) => setFilters({ ...filters, project })} />
            <Pick label="Status" any="Any status" value={filters.category} choices={TICKET_CATEGORIES.filter((c) => everything.some((t) => t.status.category === c)).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} onChange={(category) => setFilters({ ...filters, category: category as TicketFilters['category'] })} />
            <Pick label="Priority" any="Any priority" value={filters.priority} choices={plainChoices(choicesOf(everything, 'priorityName'))} onChange={(priority) => setFilters({ ...filters, priority })} />
            {everything.length > 1 && (
              <select
                aria-label="Sort tickets"
                className="form-control inbox-pick set inbox-sort"
                value={`${sort.by}-${sort.descending}`}
                onChange={(event) => setSort(SORT_OPTIONS[event.target.selectedIndex] ?? DEFAULT_TICKET_SORT)}
              >
                {SORT_OPTIONS.map((option) => {
                  const direction = option.by === 'priority'
                    ? (option.descending ? 'Highest first' : 'Lowest first')
                    : ticketSortDirectionLabel(option);
                  const key = `${option.by}-${option.descending}`;
                  return <option key={key} value={key}>{TICKET_SORT_LABEL[option.by]} · {direction.toLowerCase()}</option>;
                })}
              </select>
            )}
          </div>
        )}
        {filtering && everything.length > 0 && (
          <div className="inbox-filter-summary">
            <span role="status">{matchCount} of {everything.length} tickets</span>
            <button type="button" className="link-button" onClick={() => setFilters(NO_TICKET_FILTERS)}>Clear filters</button>
          </div>
        )}
      </div>
      {view.problems.length > 0 && (
        <ul className="prs-unasked" aria-label="Trackers that could not be asked">
          {view.problems.map((p) => (
            <li key={p.source}>
              Could not ask {p.source}: {p.reason}. Its tickets show what was last seen.
            </li>
          ))}
        </ul>
      )}
      {started.length > 0 && (
        <section className="page-section">
          <h2>
            Under way <span className="section-count">· {started.length}</span>
          </h2>
          <ul className="inbox-list">
            {underWay.map((ticket) => (
              <TicketRow key={ticket.key} ticket={ticket} dismissed={false} underWay />
            ))}
          </ul>
          {started.length > UNDER_WAY_SHOWN && (
            <button type="button" className="link-button inbox-show-all" onClick={() => setAllUnderWay(!allUnderWay)}>
              {allUnderWay ? `Show the first ${UNDER_WAY_SHOWN}` : `Show all ${started.length}`}
            </button>
          )}
        </section>
      )}
      {everything.length === 0 ? (
        <Empty which={which} sources={view.sources} />
      ) : matchCount === 0 ? (
        <div className="empty">
          <h2>No ticket matches these filters</h2>
        </div>
      ) : list.length > 0 && (
        <section className="page-section">
          {split.started.length > 0 && (
            <h2>Not started <span className="section-count">· {list.length}</span></h2>
          )}
          {groups.map((group) => (
            <div key={group.sprint ?? ''} className="tickets-sprint">
              {(group.sprint || groups.length > 1) && (
                <h2>
                  {group.sprint ?? 'Not in the current sprint'} <span className="section-count">· {group.tickets.length}</span>
                </h2>
              )}
              <ul className="inbox-list">
                {group.tickets.map((ticket) => (closed ? <ClosedRow key={ticket.key} ticket={ticket as ClosedTicket} /> : <TicketRow key={ticket.key} ticket={ticket} dismissed={dismissed} />))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
