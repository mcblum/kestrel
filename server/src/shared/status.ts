// One vocabulary for where a session stands, defined once. Every label, filter, count and dot in
// the UI is derived from this file; do not write status words anywhere else.
//
//   Needs you        waiting on a decision or blocked (an approval, a question, a failure)
//   Working          an agent is running
//   Ready to review  finished, and its newest linked pull or merge request is open as last seen:
//                    a person is being asked to review it. The only way to be ready to review.
//   Done             finished with nothing waiting on a person: no linked request (whatever its work
//                    changed), or the newest one is merged, closed, a draft (nobody is asked to review
//                    a draft) or of unknown state; or it handed off
//   Stopped          finished because the user stopped it (Stop, Stop all sessions): grey, with the
//                    finished work (it is not waiting on anyone). Read from Session.stopped, never the note
//   Interrupted      the server restarted under it; reply to resume
//   Failed           a kind of Needs you: the run broke, and the row says why
import type { SessionState, SessionView } from '../model.ts';
import { hasTag } from './tags.ts';
import { sessionDot, summaryDot, type RowDot, type Seen } from './unread.ts';

export type StatusKey = 'needs-you' | 'working' | 'review' | 'done' | 'stopped' | 'interrupted' | 'failed';

export const STATUS_LABEL: Record<StatusKey, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  review: 'Ready to review',
  done: 'Done',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  failed: 'Failed',
};

/** Order for sorting: what needs a person first. */
const STATUS_ORDER: StatusKey[] = ['needs-you', 'failed', 'working', 'interrupted', 'review', 'stopped', 'done'];

/** The sidebar and row dot. */
export const STATUS_DOT: Record<StatusKey, 'amber' | 'green' | 'idle'> = { 'needs-you': 'amber', failed: 'amber', working: 'green', interrupted: 'idle', review: 'idle', done: 'idle', stopped: 'idle' };

/** The runtime writes a failed run as a session needing you, with a note that starts like this. */
const FAILURE_NOTE = /^(Failed\b|Claude is not signed in)/;
const HANDED_OFF_NOTE = /^Handed off/;

export const isFailureNote = (note: string) => FAILURE_NOTE.test(note);

/** What status is worked out from. `request` (SessionView) may be left out, which reads as no request. */
export type Statused = Pick<SessionView, 'state' | 'note'> & Partial<Pick<SessionView, 'request' | 'stopped'>>;

export function statusOf(s: Statused): StatusKey {
  switch (s.state as SessionState) {
    case 'running':
      return 'working';
    case 'attention':
      return isFailureNote(s.note) ? 'failed' : 'needs-you';
    case 'interrupted':
      return 'interrupted';
    case 'done':
      // An open request still asks for review, stopped or not.
      if (s.request === 'open' && !HANDED_OFF_NOTE.test(s.note)) return 'review';
      return s.stopped ? 'stopped' : 'done';
  }
}

export const statusLabel = (s: Statused) => STATUS_LABEL[statusOf(s)];

// ---- filters ---------------------------------------------------------------------------------

/** The filter chips. `needs-you` is the whole queue (failed runs included). */
export type FilterKey = 'all' | 'needs-you' | 'working' | 'review' | 'done' | 'interrupted';
export const FILTER_LABEL: Record<FilterKey, string> = { all: 'All', 'needs-you': STATUS_LABEL['needs-you'], working: STATUS_LABEL.working, review: STATUS_LABEL.review, done: STATUS_LABEL.done, interrupted: STATUS_LABEL.interrupted };
const FILTER_ORDER: FilterKey[] = ['all', 'needs-you', 'working', 'review', 'done', 'interrupted'];

/** The filter chip a status is counted under: failed runs need you, stopped ones are finished work. */
export function filterOf(status: StatusKey): Exclude<FilterKey, 'all'> {
  if (status === 'failed') return 'needs-you';
  return status === 'stopped' ? 'done' : status;
}

export function matchesFilter(s: Statused, filter: FilterKey): boolean {
  return filter === 'all' || filterOf(statusOf(s)) === filter;
}

export type FilterCounts = Record<FilterKey, number>;

export function countByFilter(sessions: readonly Statused[]): FilterCounts {
  const counts: FilterCounts = { all: sessions.length, 'needs-you': 0, working: 0, review: 0, done: 0, interrupted: 0 };
  for (const s of sessions) counts[filterOf(statusOf(s))]++;
  return counts;
}

/** The chips to show with their counts. "Interrupted" appears only when something is. */
export function filterChips(counts: FilterCounts): { key: FilterKey; label: string; count: number }[] {
  return FILTER_ORDER.filter((k) => k !== 'interrupted' || counts.interrupted > 0).map((key) => ({ key, label: FILTER_LABEL[key], count: counts[key] }));
}

export interface Filters {
  status: FilterKey;
  query: string;
}
export const NO_FILTERS: Filters = { status: 'all', query: '' };
export const hasFilters = (f: Filters) => f.status !== 'all' || f.query.trim() !== '';

/** Sessions that pass the status chip and the search text. `haystack` says what a row can be found by. */
export function applyFilters<T extends SessionView>(sessions: readonly T[], filters: Filters, haystack: (s: T) => string): T[] {
  const q = filters.query.trim().toLowerCase();
  return sessions.filter((s) => matchesFilter(s, filters.status) && (!q || haystack(s).toLowerCase().includes(q)));
}

// ---- sorting ---------------------------------------------------------------------------------

export type SortKey = 'updated' | 'session' | 'status' | 'project';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_SORT: Sort = { key: 'updated', dir: 'desc' };

export function sortSessions<T extends SessionView>(sessions: readonly T[], sort: Sort, projectOf: (s: T) => string): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const value = (s: T): string | number => {
    switch (sort.key) {
      case 'updated':
        return s.updatedAt;
      case 'session':
        return s.title.toLowerCase();
      case 'status':
        return STATUS_ORDER.indexOf(statusOf(s));
      case 'project':
        return projectOf(s).toLowerCase();
    }
  };
  return [...sessions].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const order = x < y ? -1 : x > y ? 1 : 0;
    // Ties always fall back to most recently updated, whichever way the column is sorted.
    return order !== 0 ? order * sign : b.updatedAt - a.updatedAt;
  });
}

// ---- views and their empty states ------------------------------------------------------------

export type ViewKind = 'overview' | 'attention' | 'all' | 'unscoped' | 'group' | 'project' | 'tag';

/** The sessions a destination lists: filed where their work landed, hidden parents left out. */
export function inView(session: SessionView, view: { kind: ViewKind; id?: string }): boolean {
  switch (view.kind) {
    case 'group':
      return session.groupId === view.id;
    case 'project':
      return session.filing.status !== 'hidden' && session.filing.projectId === view.id;
    case 'unscoped':
      return session.filing.status === 'unscoped';
    case 'tag':
      // Every session with the tag, in any case, wherever it is filed.
      return hasTag(session.tags, view.id ?? '');
    case 'attention':
      return session.filing.status !== 'hidden' && session.state === 'attention';
    default:
      return session.filing.status !== 'hidden';
  }
}

export type EmptyKind = 'first-session' | 'overview' | 'project' | 'folder' | 'attention' | 'filtered' | 'list';

/**
 * Which empty state a page shows, or null when it has rows. `unfiltered` is how many sessions the
 * view holds before the chips and search; if that is more than zero the emptiness is the filters'.
 */
export function emptyState(input: { view: ViewKind; shown: number; unfiltered: number; projects: number; sessions: number }): EmptyKind | null {
  if (input.shown > 0) return null;
  // A workspace with no sessions yet is a first-session experience, whether or not projects exist.
  if (input.view === 'overview' && input.sessions === 0) return 'first-session';
  // "Nothing needs you" is only true of a workspace that has had sessions.
  if (input.view === 'attention' && input.sessions === 0) return 'list';
  if (input.unfiltered > 0) return 'filtered';
  switch (input.view) {
    case 'overview':
      return 'overview';
    case 'project':
      return 'project';
    case 'group':
      return 'folder';
    case 'attention':
      return 'attention';
    default:
      return 'list';
  }
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const word = (n: number) => WORDS[n] ?? String(n);

/**
 * The line under the Overview heading: what to do next, in the vocabulary above. `unread` counts
 * finished sessions the user has not looked at since (overview.ts); they come right after input.
 */
export function overviewLine(counts: Pick<FilterCounts, 'needs-you' | 'working' | 'review'> & { unread?: number }): string {
  const n = counts['needs-you'];
  const unread = counts.unread ?? 0;
  if (n > 0) return `${word(n)} ${n === 1 ? 'session needs' : 'sessions need'} your input.`;
  if (unread > 0) return `Nothing needs your input. ${word(unread)} ${unread === 1 ? 'session has' : 'sessions have'} results you have not read.`;
  if (counts.working > 0) return `${word(counts.working)} ${counts.working === 1 ? 'session is' : 'sessions are'} working. Nothing needs your input.`;
  if (counts.review > 0) return `${word(counts.review)} ${counts.review === 1 ? 'session is' : 'sessions are'} ready to review.`;
  return 'Nothing needs your input.';
}

/**
 * The sessions listed under a tag in the sidebar, in the tag page's order (most recently updated
 * first): every session carrying the tag in any case, wherever it is filed. Flat: a delegate is
 * listed on its own, not under its parent. Tags are additional, so these stay in their own homes too.
 */
/** A workstream's dots, least complete first (Matt, 2026-11-18): still working, then waiting on the user, then something new to read. */
export const WORKSTREAM_DOT_ORDER: readonly Exclude<RowDot, 'none'>[] = ['working', 'needs-you', 'unread'];

/**
 * The dots on a workstream's top row in the sidebar. Folded, the row answers for every session the
 * workstream points at, so it carries one dot for each kind of state among them (the lead's
 * included), each kind once, in `WORKSTREAM_DOT_ORDER`: one session working and another finished
 * shows the grey pulsing dot and the green one. Unfolded, each session under it shows its own dot,
 * so the row carries only the lead's, which has no row of its own there.
 */
export function workstreamDots(sessions: readonly SessionView[], sessionIds: readonly string[], leadId: string | null, folded: boolean, seen: Seen | null): Exclude<RowDot, 'none'>[] {
  const shown = new Set(folded ? sessionIds : leadId ? [leadId] : []);
  const present = new Set(sessions.filter((s) => shown.has(s.id)).map((s) => sessionDot(s, seen)));
  return WORKSTREAM_DOT_ORDER.filter((dot) => present.has(dot));
}

export function tagSessionIds(sessions: readonly SessionView[], tag: string): string[] {
  return sortSessions(sessions.filter((s) => inView(s, { kind: 'tag', id: tag })), DEFAULT_SORT, () => '').map((s) => s.id);
}

/**
 * The dot on a tag's sidebar row: the same roll-up a group row shows for its sessions, over every
 * session carrying the tag (yellow when one needs the user, else green when one is unread). `seen`
 * is null until the first run has recorded what exists; nothing is unread before then.
 */
export function tagDot(sessions: readonly SessionView[], tag: string, seen: Seen | null): 'needs-you' | 'unread' | 'none' {
  const tagged = sessions.filter((s) => inView(s, { kind: 'tag', id: tag }));
  return summaryDot(tagged.map((s) => sessionDot(s, seen)));
}
