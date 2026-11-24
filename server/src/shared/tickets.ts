// Tickets from a tracker (docs/designs/tickets.md): what every tracker has, the order they are
// listed in, which ticket a session works on, and the view the server pushes whole to the `tickets`
// slice. Pure and browser-safe: the server's store and the Tickets page share it.
import { isReviewPlace, SIDEBAR_LIMIT, type ReviewPlace } from './review-settings.ts';
import type { Workstream } from '../model.ts';
import { leadOf } from './workstreams.ts';
import { asSourced, type Sourced } from './sourced.ts';

/** Every tracker names its statuses freely; Kestrel works with one of these four. */
export type TicketCategory = 'todo' | 'in-progress' | 'in-review' | 'done';
export const TICKET_CATEGORIES: readonly TicketCategory[] = ['todo', 'in-progress', 'in-review', 'done'];
export const CATEGORY_LABEL: Record<TicketCategory, string> = { todo: 'To do', 'in-progress': 'In progress', 'in-review': 'In review', done: 'Done' };

/** A Jira sprint, a GitLab iteration, a Linear cycle. */
export interface TicketSprint {
  name: string;
  /** Whether it is the one under way now. */
  current: boolean;
}

export interface Ticket {
  /** Unique across trackers: the source, then the tracker's own identity (`gitlab:host/group/app#12`, `jira:site/PLAT-12`). */
  key: string;
  /** Which source it came from: `gitlab`, `jira`, `fake`. */
  source: string;
  /** How the tracker names itself to a person: GitLab, Jira. */
  tracker: string;
  /** The tracker's own short name for it: `PLAT-1234`, `app#12`. Also the tag a session working on it gets. */
  ref: string;
  title: string;
  status: { name: string; category: TicketCategory };
  /** The tracker's project or team, as it names it. */
  project: string;
  url: string;
  openedAt: number;
  updatedAt: number;
  /** 1 is the most urgent; absent where the tracker has no priority. */
  priority?: number;
  priorityName?: string;
  assignee?: string;
  sprint?: TicketSprint | null;
  /** Where the tracker's project lives as a repository, for matching a Kestrel project: `host` and `repository` (GitLab). */
  repository?: { hostName: string; path: string };
  /** The tracker project's short key (a Jira project's `PLAT`, a Linear team's `ENG`), also matched to a Kestrel project. */
  projectKey?: string;
}

/** A status a ticket can be moved to now, as its tracker names it. Moves name the status, so Undo is the same move back. */
export interface TicketMove {
  name: string;
  category: TicketCategory;
  /**
   * The word the status menu offers for it, where that differs from the status it leads to: GitHub's
   * "Close" leads to Closed (not planned), beside "Done" (Matt, 2026-11-22). Absent: the name.
   */
  label?: string;
  /**
   * A done status that does not say the work was completed: GitHub's closed as not planned (Matt,
   * 2026-11-23: "Done should mean that the work was completed"). Moved to from Kestrel, the ticket goes
   * to Closed, not Done.
   */
  notCompleted?: true;
}

/** Whether a move made from Kestrel puts a ticket in Done (the work was completed) rather than Closed. Pure. */
export const marksDone = (status: TicketMove): boolean => status.category === 'done' && status.notCompleted !== true;

export interface TicketComment {
  author: string;
  at: number;
  body: string;
}

/** What a ticket says, as the tracker has it: asked for when its page is open, never per row. */
export interface TicketDetail {
  description: string;
  /** Acceptance criteria, where the description has them (`criteriaOf`). */
  criteria: string[];
  comments: TicketComment[];
}

/** A ticket attached to the work on it (section 7). Lineage: it does not change when a session moves. */
export interface TicketLink {
  ticketKey: string;
  attachedTo: 'session' | 'workstream';
  id: string;
  role: 'lead' | 'part';
  at: number;
}

/**
 * A ticket Kestrel held (listed, dismissed or attached) that left the assigned list and that its tracker
 * then said was done (Matt, 2026-11-22: "We only need to show closed tickets that were once inside of
 * Kestrel"). Its last status, and when Kestrel found it closed.
 */
export interface ClosedTicket extends Ticket {
  closedAt: number;
  /**
   * The user moved it to a done status from Kestrel (Matt, 2026-11-22): it is in Done, not Closed, and it
   * goes there at once, without waiting for its tracker to stop listing it.
   */
  doneHere?: true;
  /**
   * The user closed it from Kestrel without its work being completed (GitHub's Close, not planned): it is
   * in Closed, and goes there at once, as `doneHere` goes to Done. Never both.
   */
  closedHere?: true;
}

/** How a ticket closed from Kestrel with this status is marked: Done when the work was completed, Closed otherwise. Pure. */
export const closedHereMark = (status: TicketMove): Pick<ClosedTicket, 'doneHere' | 'closedHere'> => (marksDone(status) ? { doneHere: true } : { closedHere: true });

/** Whether a held closed ticket was closed from Kestrel, either way, so it shows closed while its tracker still lists it. Pure. */
export const closedFromHere = (t: Pick<ClosedTicket, 'doneHere' | 'closedHere'>): boolean => t.doneHere === true || t.closedHere === true;

/** The held closed tickets the user marked done here (Done), and every other closed one, closed here or elsewhere (Closed). Pure. */
export const doneHere = (closed: readonly ClosedTicket[]): ClosedTicket[] => closed.filter((t) => t.doneHere);
export const closedElsewhere = (closed: readonly ClosedTicket[]): ClosedTicket[] => closed.filter((t) => !t.doneHere);

/** The most closed tickets held: the newest by when they closed. */
export const CLOSED_TICKET_LIMIT = 100;

export interface TicketsView {
  /** Open tickets assigned to the user, not dismissed, in `ticketOrder`. */
  tickets: Ticket[];
  /** Keys of the listed tickets the user has not opened. */
  unread: string[];
  dismissed: Ticket[];
  /** Held tickets that closed, newest first: never unread, counted or started on. Only the sources in use. */
  closed: ClosedTicket[];
  /** Tickets attached to work that are no longer listed (reassigned, closed): their last known state. */
  attached: Ticket[];
  links: TicketLink[];
  /** A ticket's description and comments, by key, once its page asked for them. */
  details: Record<string, Sourced<TicketDetail>>;
  /** Sources that could not be asked, and why. */
  problems: { source: string; reason: string }[];
  /** The sources asked, by name, so an empty list can say where it looked. */
  sources: string[];
  /** Settings → Tickets. Only the user changes it; no tool can. */
  settings: TicketSettings;
}

/** The trackers Kestrel knows, in the order Settings → Tickets lists them. */
export type TicketSourceId = 'gitlab' | 'github' | 'jira' | 'linear';
export const TICKET_SOURCE_IDS: readonly TicketSourceId[] = ['gitlab', 'github', 'jira', 'linear'];
export const TICKET_SOURCE_LABEL: Record<TicketSourceId, string> = { gitlab: 'GitLab issues', github: 'GitHub issues', jira: 'Jira Cloud', linear: 'Linear' };

/**
 * Settings → Tickets (Matt, 2026-11-22): tickets are off until the user turns them on; then every
 * source that is ready is used, except the ones the user switched off (`off`). Only the user changes it.
 */
export interface TicketSettings {
  on: boolean;
  /** Sources the user switched off. A source not named here is used once it is ready. */
  off: TicketSourceId[];
  /** Where tickets show, as Code reviews has it: their own page (the default), the TICKETS section of the sidebar, or both. */
  show: ReviewPlace;
  /**
   * The tracker projects or teams the user matched to a Kestrel project, by its id: the names or keys as
   * the tracker gives them (`PLAT`, `Platform API`). Work this ticket starts in the matched project before
   * any other match. Absent when nothing is matched.
   */
  matches?: TicketMatches;
}

/** Kestrel project id → the tracker projects or teams matched to it. */
export type TicketMatches = Record<string, string[]>;

/** The most names one Kestrel project is matched to, and the longest name. */
export const MAX_TICKET_MATCHES = 20;
const MAX_MATCH_NAME = 120;

/** Typed or stored matches, checked: names trimmed, blanks and repeats dropped, a project with none left out. Pure. */
export function asTicketMatches(raw: unknown): TicketMatches {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: TicketMatches = {};
  for (const [id, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !Array.isArray(names)) continue;
    const kept = [...new Set(names.filter((n): n is string => typeof n === 'string').map((n) => n.trim().slice(0, MAX_MATCH_NAME)).filter(Boolean))].slice(0, MAX_TICKET_MATCHES);
    if (kept.length > 0) out[id] = kept;
  }
  return out;
}

/** A tracker name compared as a person would: case, spaces and punctuation ignored. Pure. */
export const plainName = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The Kestrel project id the user matched this ticket's tracker project or team to, or null. Pure. */
export function matchedProjectId(ticket: Pick<Ticket, 'project' | 'projectKey'>, matches: TicketMatches | undefined): string | null {
  const names = new Set([plainName(ticket.project), plainName(ticket.projectKey ?? '')].filter(Boolean));
  for (const [id, list] of Object.entries(matches ?? {})) if (list.some((n) => names.has(plainName(n)))) return id;
  return null;
}

export const NO_TICKET_SETTINGS: TicketSettings = { on: false, off: [], show: 'page' };

/** How many tickets nobody has started on the TICKETS section lists before Show more, as CODE REVIEWS does by default. */
export const TICKET_SECTION_LIMIT = SIDEBAR_LIMIT.initial;

/** Whether the sidebar has the TICKETS section. Pure. */
export const hasTicketSection = (settings: Pick<TicketSettings, 'on' | 'show'>): boolean => settings.on && settings.show !== 'page';
/** Whether the top menu has the Tickets row (the page is there whichever is chosen: Show more opens it). Pure. */
export const hasTicketLink = (settings: Pick<TicketSettings, 'on' | 'show'>): boolean => settings.on && settings.show !== 'sidebar';

const isSourceId = (v: unknown): v is TicketSourceId => typeof v === 'string' && (TICKET_SOURCE_IDS as readonly string[]).includes(v);

/** Stored settings, checked: anything malformed reads as off, an unknown source is dropped. Pure. */
export function asTicketSettings(raw: unknown): TicketSettings {
  if (typeof raw !== 'object' || raw === null) return NO_TICKET_SETTINGS;
  const r = raw as { on?: unknown; off?: unknown; show?: unknown; matches?: unknown };
  const off = Array.isArray(r.off) ? TICKET_SOURCE_IDS.filter((id) => (r.off as unknown[]).includes(id)) : [];
  const matches = asTicketMatches(r.matches);
  return { on: r.on === true, off, show: isReviewPlace(r.show) ? r.show : NO_TICKET_SETTINGS.show, ...(Object.keys(matches).length > 0 ? { matches } : {}) };
}

/**
 * Whether tickets are on: the one test, for the server (the background sync, the routes) and the page
 * (the Tickets row, its count, the Tickets page) alike. Off, no tracker is asked and nothing about
 * tickets shows but the chip on work a ticket is already attached to. Pure.
 */
export function ticketsOn(view: Pick<TicketsView, 'settings'>): boolean {
  return view.settings.on;
}

/** Which tracker a source is (`gitlab@host` is GitLab); null for the scripted sample one. Pure. */
export function sourceIdOf(kind: string): TicketSourceId | null {
  const id = kind.split(/[@:]/)[0]!;
  return isSourceId(id) ? id : null;
}

/**
 * Whether a source is asked and its tickets listed: tickets on, and the source not switched off. The
 * one test, for the server's sync and store and the Settings page alike. The sample tracker follows
 * the main switch only. Pure.
 */
export function ticketSourceOn(settings: TicketSettings, kind: string): boolean {
  const id = sourceIdOf(kind);
  return settings.on && (id === null || !settings.off.includes(id));
}

/** The settings with one source switched on or off. Pure. */
export function withTicketSource(settings: TicketSettings, id: TicketSourceId, on: boolean): TicketSettings {
  const off = TICKET_SOURCE_IDS.filter((x) => (x === id ? !on : settings.off.includes(x)));
  return { ...settings, off };
}

/** How a source stands, for Settings → Tickets: ready to use, needing something first, or not built. */
export interface TicketSourceStatus {
  id: TicketSourceId;
  /** `sample`: a copy showing sample data, where the sample tracker stands in for this one and nothing is asked. */
  state: 'ready' | 'needs-setup' | 'not-built' | 'sample';
  /** What is used (ready) or what is missing and how to fix it, in a line. */
  line: string;
}

/** What a refused tickets action says while tickets are off. */
export const TICKETS_OFF_REASON = 'Tickets are off. Turn them on in Settings → Tickets.';

/** One line per tracker the user switched off while tickets are on, for a list that would otherwise just lack its tickets. Pure. */
export const ticketSourcesOff = (settings: TicketSettings): string[] => (settings.on ? settings.off.map((id) => `${TICKET_SOURCE_LABEL[id]} ${id === 'jira' || id === 'linear' ? 'is' : 'are'} switched off in Settings → Tickets.`) : []);

export const NO_TICKETS: TicketsView = { tickets: [], unread: [], dismissed: [], closed: [], attached: [], links: [], details: {}, problems: [], sources: [], settings: NO_TICKET_SETTINGS };

/** A group of the list: the current sprint (by name) first, then the rest (`sprint: null`). */
export interface TicketGroup {
  sprint: string | null;
  tickets: Ticket[];
}

const byUrgency = (a: Ticket, b: Ticket): number => (a.priority ?? 99) - (b.priority ?? 99) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key);

/**
 * The one order of tickets, for the section and the page (Matt, 2026-11-22: "list the tickets that
 * are part of the user's current sprint first"): each current sprint's tickets under its name, then
 * the rest; within each, most urgent first, then most recently updated. Pure.
 */
export function ticketOrder(tickets: readonly Ticket[]): TicketGroup[] {
  const sprints = new Map<string, Ticket[]>();
  const rest: Ticket[] = [];
  for (const ticket of tickets) {
    if (ticket.sprint?.current) sprints.set(ticket.sprint.name, [...(sprints.get(ticket.sprint.name) ?? []), ticket]);
    else rest.push(ticket);
  }
  const groups = [...sprints].sort(([a], [b]) => a.localeCompare(b)).map(([sprint, list]) => ({ sprint, tickets: [...list].sort(byUrgency) }));
  return rest.length > 0 || groups.length === 0 ? [...groups, { sprint: null, tickets: [...rest].sort(byUrgency) }] : groups;
}

/** What the Tickets page orders by, inside each sprint group (Matt, 2026-11-22). */
export const TICKET_SORT_BY = ['priority', 'opened', 'updated'] as const;
export type TicketSortBy = (typeof TICKET_SORT_BY)[number];
export const TICKET_SORT_LABEL: Record<TicketSortBy, string> = { priority: 'Priority', opened: 'Opened', updated: 'Updated' };

export interface TicketSort {
  by: TicketSortBy;
  /** Most urgent, or newest, first. */
  descending: boolean;
}

/** The order the page opens in: `ticketOrder`'s own. */
export const DEFAULT_TICKET_SORT: TicketSort = { by: 'priority', descending: true };

/** What the direction arrow says. */
export const ticketSortDirectionLabel = (sort: TicketSort): string =>
  sort.by === 'priority' ? (sort.descending ? 'Most urgent first' : 'Least urgent first') : sort.descending ? 'Newest first' : 'Oldest first';

/** `tickets` in the page's chosen order; the key settles a tie. Pure. */
export function sortTickets(tickets: readonly Ticket[], sort: TicketSort): Ticket[] {
  const way = sort.descending ? 1 : -1;
  const compare = (a: Ticket, b: Ticket): number =>
    sort.by === 'priority' ? way * byUrgency(a, b) : way * ((sort.by === 'opened' ? b.openedAt - a.openedAt : b.updatedAt - a.updatedAt) || a.key.localeCompare(b.key));
  return [...tickets].sort(compare);
}

/** The tickets in `ticketOrder`, as one list. Pure. */
export const orderTickets = (tickets: readonly Ticket[]): Ticket[] => ticketOrder(tickets).flatMap((g) => g.tickets);

/** The ticket a session works on: its own, else its workstream's. At most one. Pure. */
export function ticketOf(sessionId: string, links: readonly TicketLink[], workstreams: readonly Pick<Workstream, 'id' | 'sessionIds'>[]): TicketLink | null {
  const own = links.find((l) => l.attachedTo === 'session' && l.id === sessionId);
  if (own) return own;
  const stream = workstreams.find((w) => w.sessionIds.includes(sessionId));
  if (!stream) return null;
  // The workstream's own ticket, else the one its lead was started on: a lead that delegates across
  // projects makes the workstream, and the ticket it was given is the whole workstream's.
  return links.find((l) => l.attachedTo === 'workstream' && l.id === stream.id) ?? links.find((l) => l.attachedTo === 'session' && l.role === 'lead' && stream.sessionIds.includes(l.id)) ?? null;
}

/** The session leading the work on a ticket, if one still exists: its lead session, else the lead of the workstream it is attached to. Pure. */
export function ticketLead(key: string, links: readonly TicketLink[], workstreams: readonly Pick<Workstream, 'id' | 'sessionIds'>[], live: ReadonlySet<string>): string | null {
  const own = links.find((l) => l.ticketKey === key && l.attachedTo === 'session' && l.role === 'lead' && live.has(l.id));
  if (own) return own.id;
  for (const link of links) {
    if (link.ticketKey !== key || link.attachedTo !== 'workstream') continue;
    const stream = workstreams.find((w) => w.id === link.id);
    const lead = stream ? leadOf(stream) : null;
    if (lead && live.has(lead)) return lead;
  }
  return null;
}

/** A workstream's ticket: its own, else its lead's. Pure. */
export function ticketOfWorkstream(stream: Pick<Workstream, 'id' | 'sessionIds'>, links: readonly TicketLink[]): TicketLink | null {
  return links.find((l) => l.attachedTo === 'workstream' && l.id === stream.id) ?? links.find((l) => l.attachedTo === 'session' && l.role === 'lead' && stream.sessionIds.includes(l.id)) ?? null;
}

/** The sessions and workstreams a ticket is attached to. Pure. */
export const linksOfTicket = (key: string, links: readonly TicketLink[]): TicketLink[] => links.filter((l) => l.ticketKey === key);

/** Any ticket held, listed, dismissed, closed or attached, by key. Pure. */
export const findTicket = (view: Pick<TicketsView, 'tickets' | 'dismissed' | 'closed' | 'attached'>, key: string): Ticket | undefined =>
  view.tickets.find((t) => t.key === key) ?? view.dismissed.find((t) => t.key === key) ?? view.closed.find((t) => t.key === key) ?? view.attached.find((t) => t.key === key);

/** Whether a ticket is one of the held closed ones. Pure. */
export const isClosedTicket = (view: Pick<TicketsView, 'closed'>, key: string): boolean => view.closed.some((t) => t.key === key);

/** Closed tickets kept as the store keeps them: one per key, the newest closings, at most `CLOSED_TICKET_LIMIT`. Pure. */
export function keptClosed(closed: readonly ClosedTicket[]): ClosedTicket[] {
  const byKey = new Map<string, ClosedTicket>();
  for (const t of closed) if ((byKey.get(t.key)?.closedAt ?? -1) < t.closedAt) byKey.set(t.key, t);
  return [...byKey.values()].sort((a, b) => b.closedAt - a.closedAt || a.key.localeCompare(b.key)).slice(0, CLOSED_TICKET_LIMIT);
}

/** A row's second line: ref, tracker project, status, how long ago it changed. Pure. */
export function ticketRowDetail(ticket: Ticket, updated: string): string {
  return [ticket.ref, ticket.project, ticket.status.name, updated && `updated ${updated}`].filter(Boolean).join(' · ');
}

/**
 * The tickets with work under way: Kestrel's own fact, separate from the tracker's status. A ticket is
 * under way while it is attached to a session that is not archived, or to a workstream that is not
 * (Matt, 2026-11-22: "shown as in-progress within the tickets page, the same as pull request
 * reviews"). `sessions` and `workstreams` are the ids the workspace lists, which leaves the archived
 * ones out. The one test, for the Tickets page and anything else that asks. Pure.
 */
export function ticketsUnderWay(links: readonly TicketLink[], sessions: ReadonlySet<string>, workstreams: ReadonlySet<string>): Set<string> {
  return new Set(links.filter((l) => (l.attachedTo === 'session' ? sessions.has(l.id) : workstreams.has(l.id))).map((l) => l.ticketKey));
}

/** A heading or line that names a ticket's acceptance criteria ("Acceptance criteria", "AC", "Done when"). */
const CRITERIA_HEADING = /^\s*(#+\s*|\*\*|h\d\.\s*)?(acceptance criteria|ac|done when|definition of done)\b/i;

/** The acceptance criteria in a description: the list items under such a heading, up to the next heading. Pure. */
export function criteriaOf(description: string): string[] {
  const lines = description.split('\n');
  const start = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#+\s|h\d\.\s)/.test(line)) break;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (item) out.push(item[1]!.trim());
    else if (out.length > 0 && line.trim() === '') continue;
  }
  return out;
}

/** The description without its acceptance criteria block, for a page that shows them on their own. Pure. */
export function withoutCriteria(description: string): string {
  const lines = description.split('\n');
  const start = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  if (start < 0) return description;
  const rest = lines.slice(start + 1).findIndex((line) => /^\s*(#+\s|h\d\.\s)/.test(line));
  const end = rest < 0 ? lines.length : start + 1 + rest;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
}

/** A status as words: its name, and its category where the name does not already say it. Pure. */
export function statusWords(status: Ticket['status']): string {
  const label = CATEGORY_LABEL[status.category];
  return status.name.toLowerCase() === label.toLowerCase() ? status.name : `${status.name} (${label})`;
}

// ---- reading what the server pushed --------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored or pushed closed ticket, checked. */
function asClosedTicket(raw: unknown): ClosedTicket | null {
  const ticket = asTicket(raw);
  return ticket && isObject(raw) && num(raw.closedAt) ? { ...ticket, closedAt: raw.closedAt, ...(raw.doneHere === true ? { doneHere: true as const } : raw.closedHere === true ? { closedHere: true as const } : {}) } : null;
}

/** Stored closed tickets, checked and capped. Pure. */
export const asClosedTickets = (raw: unknown): ClosedTicket[] => keptClosed(Array.isArray(raw) ? raw.flatMap((t) => asClosedTicket(t) ?? []) : []);

/** Stored tickets (the held list), checked. Pure. */
export const asStoredTickets = (raw: unknown): Ticket[] => (Array.isArray(raw) ? raw.flatMap((t) => asTicket(t) ?? []) : []);

function asTicket(raw: unknown): Ticket | null {
  if (!isObject(raw) || !str(raw.key) || !str(raw.source) || !str(raw.ref) || !str(raw.title) || !isObject(raw.status)) return null;
  const category = (TICKET_CATEGORIES as readonly unknown[]).includes(raw.status.category) ? (raw.status.category as TicketCategory) : 'todo';
  const sprint = isObject(raw.sprint) && str(raw.sprint.name) ? { name: raw.sprint.name, current: raw.sprint.current === true } : null;
  const repo = isObject(raw.repository) && str(raw.repository.hostName) && str(raw.repository.path) ? { hostName: raw.repository.hostName, path: raw.repository.path } : undefined;
  return {
    key: raw.key,
    source: raw.source,
    tracker: str(raw.tracker) ? raw.tracker : raw.source,
    ref: raw.ref,
    title: raw.title,
    status: { name: str(raw.status.name) ? raw.status.name : CATEGORY_LABEL[category], category },
    project: str(raw.project) ? raw.project : '',
    url: str(raw.url) && /^https?:\/\//.test(raw.url) ? raw.url : '',
    openedAt: num(raw.openedAt) ? raw.openedAt : 0,
    updatedAt: num(raw.updatedAt) ? raw.updatedAt : 0,
    ...(num(raw.priority) ? { priority: raw.priority } : {}),
    ...(str(raw.priorityName) ? { priorityName: raw.priorityName } : {}),
    ...(str(raw.assignee) ? { assignee: raw.assignee } : {}),
    sprint,
    ...(repo ? { repository: repo } : {}),
    ...(str(raw.projectKey) ? { projectKey: raw.projectKey } : {}),
  };
}

const tickets = (raw: unknown): Ticket[] => (Array.isArray(raw) ? raw.flatMap((t) => asTicket(t) ?? []) : []);
const strings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter(str) : []);

function asLink(raw: unknown): TicketLink | null {
  if (!isObject(raw) || !str(raw.ticketKey) || !str(raw.id) || (raw.attachedTo !== 'session' && raw.attachedTo !== 'workstream')) return null;
  return { ticketKey: raw.ticketKey, attachedTo: raw.attachedTo, id: raw.id, role: raw.role === 'part' ? 'part' : 'lead', at: num(raw.at) ? raw.at : 0 };
}

export const asTicketLinks = (raw: unknown): TicketLink[] => (Array.isArray(raw) ? raw.flatMap((l) => asLink(l) ?? []) : []);

const isDetail = (v: unknown): v is TicketDetail => isObject(v) && str(v.description) && Array.isArray(v.criteria) && Array.isArray(v.comments);

/** A pushed view, checked: anything malformed is left out rather than trusted. */
export function asTicketsView(raw: unknown): TicketsView {
  if (!isObject(raw)) return NO_TICKETS;
  const details: Record<string, Sourced<TicketDetail>> = {};
  if (isObject(raw.details)) for (const [key, value] of Object.entries(raw.details)) details[key] = asSourced(value, isDetail, 'The tracker’s answer could not be read');
  return {
    tickets: tickets(raw.tickets),
    unread: strings(raw.unread),
    dismissed: tickets(raw.dismissed),
    closed: Array.isArray(raw.closed) ? raw.closed.flatMap((t) => asClosedTicket(t) ?? []) : [],
    attached: tickets(raw.attached),
    links: asTicketLinks(raw.links),
    details,
    problems: Array.isArray(raw.problems) ? raw.problems.flatMap((p) => (isObject(p) && str(p.source) && str(p.reason) ? [{ source: p.source, reason: p.reason }] : [])) : [],
    sources: strings(raw.sources),
    settings: asTicketSettings(raw.settings),
  };
}

// ---- the Tickets page's filters ------------------------------------------------------------

export interface TicketFilters {
  text: string;
  tracker: string;
  project: string;
  category: TicketCategory | '';
  priority: string;
}

export const NO_TICKET_FILTERS: TicketFilters = { text: '', tracker: '', project: '', category: '', priority: '' };

export const isFilteringTickets = (f: TicketFilters): boolean => Boolean(f.text.trim() || f.tracker || f.project || f.category || f.priority);

const folded = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** The tickets the filters leave in sight; the text search forgives case, accents and word order. Pure. */
export function filterTickets(tickets: readonly Ticket[], f: TicketFilters): Ticket[] {
  const words = folded(f.text).split(/\s+/).filter(Boolean);
  return tickets.filter((t) => {
    if (f.tracker && t.tracker !== f.tracker) return false;
    if (f.project && t.project !== f.project) return false;
    if (f.category && t.status.category !== f.category) return false;
    if (f.priority && (t.priorityName ?? '') !== f.priority) return false;
    const hay = folded([t.ref, t.title, t.project, t.status.name, t.assignee ?? '', t.sprint?.name ?? ''].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** The distinct values of one field, for a filter's choices, in a steady order. Pure. */
export function choicesOf(tickets: readonly Ticket[], field: 'tracker' | 'project' | 'priorityName'): string[] {
  const seen = new Map<string, number>();
  for (const t of tickets) {
    const v = t[field];
    if (v && !seen.has(v)) seen.set(v, field === 'priorityName' ? (t.priority ?? 99) : 0);
  }
  return [...seen].sort(([a, pa], [b, pb]) => pa - pb || a.localeCompare(b)).map(([v]) => v);
}
