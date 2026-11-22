// Code reviews: every pull or merge request somebody asked the user to review by name, as the
// server pushes them (`reviewRequests`), most recently changed first. Two lists, chosen by a chip
// kept in the tab's path: the ones waiting, and the ones the user dismissed. Each row opens its
// request (or the review session it has), links to its host, and is dismissed or restored by its
// own button; the button at the top does the same to the whole list. A request not opened yet is
// new: a green dot in place of its eye and its title brighter and bolder than a read one's, as
// unread mail is, until it is opened or Mark all read.
// The reviews the user has started (a session reviews the request) stand first, under Reviewing,
// above the filters and untouched by them, so what they took on is always in sight (the first ten,
// then Show all). The rest follow under Not started, with the filters: who asked, which project (or repository), how recently it was
// opened, and a forgiving text search (shared/review-filter.ts). They are the page's own, kept
// while it is open; Dismiss all and Mark all read act on the requests not started that the filters
// leave in sight, never on a review under way, which is dismissed by its own button. Dismissing posts nothing to
// the host and stops no session: the request is only no longer listed as waiting.
// Sort by (last activity or date opened, newest or oldest first) orders both groups, so it sits at
// the right of the Waiting / Dismissed bar; it is this browser's own choice and is remembered there.
import { memo, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCheck, ExternalLink, Eye, RotateCcw, Search, X } from 'lucide-react';
import { asReviewSort, filterReviews, isFiltering, REVIEW_SORT_BY, REVIEW_SORT_LABEL, sortDirectionLabel, sortReviews, type ReviewSort, type ReviewSortBy, NO_REVIEW_FILTERS, placeChoices, REVIEW_WITHIN, REVIEW_WITHIN_LABEL, splitStarted, whoChoices, type ReviewFilters, type ReviewWithin } from '@kestrel/server/review-filter';
import { hostTerms } from '@kestrel/server/host-terms';
import { openedText, requestStatus, reviewRowDetail, type ReviewRequest } from '@kestrel/server/review-requests';
import { statusText } from '../labels.ts';
import { useRowDot } from '../components/useRowDot.ts';
import { openRowMenu } from '../components/sidebarMenuTarget.ts';
import { useReviewSettings } from '../reviewSettings.ts';
import { openSession, openView, opener, showLocal } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { useMinuteNow } from '../useNow.ts';
import { PageHeader } from './PageHeader.tsx';

const ReviewRow = memo(function ReviewRow({ request, dismissed }: { request: ReviewRequest; dismissed: boolean }) {
  const projectName = useApp((s) => (request.projectId ? s.workspace?.projects.find((p) => p.id === request.projectId)?.name : undefined));
  // The session reviewing it, when it has one: the row opens that, and says where it stands.
  const session = useApp((s) => s.workspace?.sessions.find((x) => x.review?.key === request.key));
  const terms = hostTerms(request.host);
  const opened = openedText(request, useMinuteNow());
  // New until it is opened or marked read; a dismissed one is never new.
  const unread = useApp((s) => !dismissed && s.reviewRequests.unread.includes(request.key));
  const status = session ? `Review: ${statusText(session).toLowerCase()}` : requestStatus(request).label;
  // A review under way shows its session's own dot, as its sidebar row does: green when it has
  // finished a turn since the user last looked, yellow when it waits on an answer.
  const dot = useRowDot(dismissed ? undefined : session);
  const news = dot.className === 'green' || dot.className === 'amber';
  return (
    <li
      className={`reviews-row${unread || news ? ' unread' : ''}`}
      // Right-click: the request's own menu, the one its sidebar row has (menu.ts).
      onContextMenu={(event) => {
        event.preventDefault();
        openRowMenu('review', request.key, { x: event.clientX, y: event.clientY });
      }}
    >
      {dot.className !== 'none' ? (
        <span className={`status-dot ${dot.className} reviews-new`} role="img" aria-label={dot.label} title={dot.label} />
      ) : unread ? (
        <span className="status-dot green reviews-new" role="img" aria-label="New" title="New: you have not opened it yet" />
      ) : (
        <Eye aria-hidden className="reviews-mark" />
      )}
      <button type="button" className="reviews-open" title={request.title} {...opener((newTab) => {
          // Opening it is reading it, whichever it opens: its review session, or its own page.
          if (unread) void actions.markReviewsSeen([request.key], true);
          if (session) openSession(session.id, newTab);
          else openView({ kind: 'review-request', id: request.key }, newTab);
        })}>
        <span className="reviews-title">{request.title}</span>
        <span className="reviews-detail">{[reviewRowDetail(request, projectName), opened && `opened ${opened}`].filter(Boolean).join(' · ')}</span>
      </button>
      <span className="reviews-status" title={status}>
        {status}
      </span>
      {request.url && (
        <a className="reviews-icon" href={request.url} target="_blank" rel="noreferrer" aria-label={`Open on ${terms.service}`} title={`Open on ${terms.service}`}>
          <ExternalLink aria-hidden />
        </a>
      )}
      <button type="button" className="secondary-button small reviews-dismiss" onClick={() => void actions.dismissReviews([request.key], !dismissed)}>
        {dismissed ? <RotateCcw aria-hidden /> : <X aria-hidden />} {dismissed ? 'Restore' : 'Dismiss'}
      </button>
    </li>
  );
});

/** One select of the filter row; its first choice is no filter. */
function Pick({ label, any, value, choices, onChange }: { label: string; any: string; value: string; choices: readonly (string | { value: string; label: string })[]; onChange: (value: string) => void }) {
  return (
    <select aria-label={label} className={`form-control reviews-pick${value ? ' set' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{any}</option>
      {choices.map((choice) => {
        const option = typeof choice === 'string' ? { value: choice, label: choice } : choice;
        return (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        );
      })}
    </select>
  );
}

const WITHIN_CHOICES = REVIEW_WITHIN.filter((w) => w !== 'any').map((w) => ({ value: w, label: REVIEW_WITHIN_LABEL[w] }));

function Empty({ dismissed, off }: { dismissed: boolean; off: boolean }) {
  if (off)
    return (
      <div className="empty">
        <h2>Review requests are switched off</h2>
        <p>
          GitHub and GitLab are not asked.{' '}
          <button type="button" className="link-button" {...opener((newTab) => openView({ kind: 'settings', section: 'code-reviews' }, newTab))}>
            Change it in Settings → Code reviews
          </button>
        </p>
      </div>
    );
  return (
    <div className="empty">
      <h2>{dismissed ? 'Nothing dismissed' : 'No review is waiting on you'}</h2>
      <p>{dismissed ? 'A request you dismiss is kept here while its host still lists it, so it can be restored.' : 'A pull or merge request shows here when somebody asks you, by name, to review it.'}</p>
    </div>
  );
}

/** The order the page was last left in: a convenience of this browser, not server data. */
const SORT_KEY = 'kestrel.code-reviews.sort';

function storedSort(): ReviewSort {
  try {
    return asReviewSort(JSON.parse(window.localStorage.getItem(SORT_KEY) ?? 'null'));
  } catch {
    return asReviewSort(null);
  }
}

function rememberSort(sort: ReviewSort): void {
  try {
    window.localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    // Not remembered; the order still holds while the page is open.
  }
}

/** How many reviews under way are listed before "Show all": many can be at work when reviews start on their own. */
const REVIEWING_SHOWN = 10;

export function CodeReviewsPage({ dismissed }: { dismissed: boolean }) {
  const view = useApp((s) => s.reviewRequests);
  const off = useReviewSettings().mode === 'off';
  const projects = useApp((s) => s.workspace?.projects);
  const [filters, setFilters] = useState<ReviewFilters>(NO_REVIEW_FILTERS);
  const [sort, setSort] = useState(storedSort);
  const changeSort = (next: ReviewSort) => (setSort(next), rememberSort(next));
  const [allReviewing, setAllReviewing] = useState(false);
  const now = useMinuteNow();
  const everything = dismissed ? view.dismissed : view.requests;
  const names = useMemo(() => {
    const byId = new Map((projects ?? []).map((p) => [p.id, p.name]));
    return (id: string) => byId.get(id);
  }, [projects]);
  // The reviews the user has started (a session reviews the request) stand first, above the
  // filters and untouched by them: what they took on. A dismissed request is in neither group.
  const sessions = useApp((s) => s.workspace?.sessions);
  const startedKeys = useMemo(() => new Set(dismissed ? [] : (sessions ?? []).flatMap((s) => (s.review ? [s.review.key] : []))), [sessions, dismissed]);
  // Both groups are listed in the order chosen.
  const groups = useMemo(() => splitStarted(sortReviews(everything, sort), startedKeys), [everything, sort, startedKeys]);
  // The filters, and the buttons at the top, are about the rest.
  const list = useMemo(() => filterReviews(groups.rest, filters, names, now), [groups.rest, filters, names, now]);
  const filtering = isFiltering(filters);
  const reviewing = allReviewing ? groups.started : groups.started.slice(0, REVIEWING_SHOWN);
  const shownUnread = useMemo(() => {
    const shown = new Set(list.map((r) => r.key));
    return dismissed ? [] : view.unread.filter((key) => shown.has(key));
  }, [list, view.unread, dismissed]);
  const all = () => void actions.dismissReviews(list.map((r) => r.key), !dismissed);
  const chip = (label: string, count: number, on: boolean, filter?: 'dismissed') => (
    <button className={`chip${on ? ' selected' : ''}`} aria-pressed={on} onClick={() => showLocal(filter ? { kind: 'code-reviews', filter } : { kind: 'code-reviews' })}>
      {label} <span className="chip-count">{count}</span>
    </button>
  );
  const allLabel = dismissed ? (filtering ? `Restore ${list.length} shown` : 'Restore all') : filtering ? `Dismiss ${list.length} shown` : groups.started.length > 0 ? 'Dismiss all not started' : 'Dismiss all';
  return (
    <div className="page column reviews-page">
      <PageHeader
        title="Code reviews"
        line="The pull and merge requests you were asked to review by name."
        actions={
          <>
            {shownUnread.length > 0 && (
              <button type="button" className="secondary-button small" onClick={() => void actions.markReviewsSeen(shownUnread, true, true)}>
                <CheckCheck aria-hidden /> {filtering ? `Mark ${shownUnread.length} read` : 'Mark all read'}
              </button>
            )}
            {list.length > 0 && (
              <button type="button" className="secondary-button small" onClick={all}>
                {dismissed ? <RotateCcw aria-hidden /> : <X aria-hidden />} {allLabel}
              </button>
            )}
          </>
        }
      />
      <div className="filter-row">
        <div className="chips" role="group" aria-label="Waiting or dismissed">
          {chip('Waiting', view.requests.length, !dismissed)}
          {chip('Dismissed', view.dismissed.length, dismissed, 'dismissed')}
        </div>
        {/* The order is the whole page's, the reviews under way included, so it sits on the page's own bar and not with the filters (Matt, 2026-11-21). */}
        {everything.length > 1 && (
          <span className="reviews-sort">
            <select aria-label="Sort by" className="form-control reviews-pick set" value={sort.by} onChange={(e) => changeSort({ ...sort, by: e.target.value as ReviewSortBy })}>
              {REVIEW_SORT_BY.map((by) => (
                <option key={by} value={by}>
                  {REVIEW_SORT_LABEL[by]}
                </option>
              ))}
            </select>
            <button type="button" className="icon-button reviews-direction" aria-label={`${sortDirectionLabel(sort)}. Switch to ${sortDirectionLabel({ ...sort, descending: !sort.descending }).toLowerCase()}`} title={sortDirectionLabel(sort)} onClick={() => changeSort({ ...sort, descending: !sort.descending })}>
              {sort.descending ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden />}
            </button>
          </span>
        )}
      </div>
      {view.problems.length > 0 && (
        <ul className="prs-unasked" aria-label="Hosts that could not be asked">
          {view.problems.map((p) => (
            <li key={p.hostName}>
              Could not ask {p.hostName}: {p.reason}. Its requests show what was last seen.
            </li>
          ))}
        </ul>
      )}
      {groups.started.length > 0 && (
        <section className="page-section reviews-group">
          <h2>
            Reviewing <span className="section-count">· {groups.started.length}</span>
          </h2>
          <ul className="reviews-list">
            {reviewing.map((request) => (
              <ReviewRow key={request.key} request={request} dismissed={false} />
            ))}
          </ul>
          {groups.started.length > REVIEWING_SHOWN && (
            <button type="button" className="link-button reviews-all" onClick={() => setAllReviewing(!allReviewing)}>
              {allReviewing ? `Show the first ${REVIEWING_SHOWN}` : `Show all ${groups.started.length}`}
            </button>
          )}
        </section>
      )}
      {everything.length === 0 ? (
        <Empty dismissed={dismissed} off={off} />
      ) : (
        groups.rest.length > 0 && (
          <section className="page-section reviews-group">
            {groups.started.length > 0 && (
              <h2>
                Not started <span className="section-count">· {groups.rest.length}</span>
              </h2>
            )}
            <div className="reviews-filters" role="group" aria-label="Filter requests">
              <label className="session-search reviews-search">
                <Search aria-hidden />
                <input value={filters.text} onChange={(e) => setFilters({ ...filters, text: e.target.value })} placeholder="Search title, project, person" aria-label="Search requests" />
              </label>
              <Pick label="Who asked" any="Anyone" value={filters.who} choices={whoChoices(groups.rest)} onChange={(who) => setFilters({ ...filters, who })} />
              <Pick label="Project" any="Any project" value={filters.place} choices={placeChoices(groups.rest, names)} onChange={(place) => setFilters({ ...filters, place })} />
              <Pick label="Opened" any={REVIEW_WITHIN_LABEL.any} value={filters.within === 'any' ? '' : filters.within} choices={WITHIN_CHOICES} onChange={(within) => setFilters({ ...filters, within: (within || 'any') as ReviewWithin })} />
              {filtering && (
                <>
                  <span className="reviews-shown">
                    {list.length} of {groups.rest.length}
                  </span>
                  <button type="button" className="link-button" onClick={() => setFilters(NO_REVIEW_FILTERS)}>
                    Clear
                  </button>
                </>
              )}
            </div>
            {list.length === 0 ? (
              <div className="empty">
                <h2>No request matches these filters</h2>
              </div>
            ) : (
              <ul className="reviews-list">
                {list.map((request) => (
                  <ReviewRow key={request.key} request={request} dismissed={dismissed} />
                ))}
              </ul>
            )}
          </section>
        )
      )}
    </div>
  );
}
