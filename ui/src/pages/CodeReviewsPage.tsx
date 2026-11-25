// Reviews assigned to the user. Active review sessions are grouped above the queue. The toolbar
// (search, who asked, project, opened, approved) filters both groups, while bulk mark-read and dismiss apply to the matching queue only.
import { memo, useMemo, useState } from 'react';
import { CheckCheck, RotateCcw, X } from 'lucide-react';
import { asReviewSort, REVIEW_APPROVAL, REVIEW_APPROVAL_LABEL, type ReviewApproval, filterReviews, isFiltering, REVIEW_SORT_BY, REVIEW_SORT_LABEL, sortDirectionLabel, sortReviews, type ReviewSort, NO_REVIEW_FILTERS, placeChoices, REVIEW_WITHIN, REVIEW_WITHIN_LABEL, splitStarted, whoChoices, type ReviewFilters, type ReviewWithin } from '@kestrel/server/review-filter';
import { hostTerms } from '@kestrel/server/host-terms';
import { askedBy, openedText, repositoryName, requestNumberLabel, requestStatus, type ReviewRequest } from '@kestrel/server/review-requests';
import { OthersSaidNote } from '../components/OthersSaid.tsx';
import { InboxReference, InboxRowMenu, InboxSearch, InboxStartButton } from '../components/InboxList.tsx';
import { statusText } from '../labels.ts';
import { useRowDot } from '../components/useRowDot.ts';
import { openRowMenu } from '../components/sidebarMenuTarget.ts';
import { useReviewSettings } from '../reviewSettings.ts';
import { startRequestedReview } from '../review.ts';
import { openSession, openView, opener, showLocal } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { useMinuteNow } from '../useNow.ts';
import { PageHeader } from './PageHeader.tsx';
import { isTypedText } from '../typed-text.ts';

const ReviewRow = memo(function ReviewRow({ request, dismissed }: { request: ReviewRequest; dismissed: boolean }) {
  const project = useApp((s) => (request.projectId ? s.workspace?.projects.find((p) => p.id === request.projectId) : undefined));
  // The session reviewing it, when it has one: the row opens that, and says where it stands.
  const session = useApp((s) => s.workspace?.sessions.find((x) => x.review?.key === request.key));
  const terms = hostTerms(request.host);
  const opened = openedText(request, useMinuteNow());
  // New until it is opened or marked read; a dismissed one is never new.
  const unread = useApp((s) => !dismissed && s.reviewRequests.unread.includes(request.key));
  const status = session ? `Review: ${statusText(session).toLowerCase()}` : request.notStarted ? 'Could not start' : '';
  const statusDetail = !session && request.notStarted ? requestStatus(request).label : status;
  // A review under way shows its session's own dot, as its sidebar row does: green when it has
  // finished a turn since the user last looked, yellow when it waits on an answer.
  const dot = useRowDot(dismissed ? undefined : session);
  const news = dot.className === 'green' || dot.className === 'amber';
  return (
    <li
      className={`inbox-row${unread || news ? ' unread' : ''}`}
      // Right-click: the request's own menu, the one its sidebar row has (menu.ts).
      onContextMenu={(event) => {
        if (isTypedText(event.target)) return;
        event.preventDefault();
        openRowMenu('review', request.key, { x: event.clientX, y: event.clientY });
      }}
    >
      <span className="inbox-indicator">
        {dot.className !== 'none' ? (
          <span className={`status-dot ${dot.className}`} role="img" aria-label={dot.label} title={dot.label} />
        ) : unread ? (
          <span className="status-dot green" role="img" aria-label="New review" title="New review" />
        ) : null}
      </span>
      <button type="button" className="inbox-open" title={session ? `Open review session for ${request.title}` : request.title} {...opener((newTab) => {
          // Opening it is reading it, whichever it opens: its review session, or its own page.
          if (unread) void actions.markReviewsSeen([request.key], true);
          if (session) openSession(session.id, newTab);
          else openView({ kind: 'review-request', id: request.key }, newTab);
        })}>
        <span className="inbox-title">{request.title}</span>
        <span className="inbox-meta">
          <InboxReference service={terms.service}>{requestNumberLabel(request)}</InboxReference>
          <span>{project?.name || repositoryName(request.repository)}</span>
          {askedBy(request) && <span>{askedBy(request)}</span>}
          {opened && <span>Opened {opened}</span>}
          <OthersSaidNote request={request} />
        </span>
      </button>
      <span className="inbox-status">
        {status && <span className="inbox-status-note review-inbox-status" title={statusDetail}>{status}</span>}
        {!dismissed && !session && project && (
          <InboxStartButton label="Start review" reference={requestNumberLabel(request)} onStart={(newTab) => startRequestedReview(request.key, newTab)} />
        )}
      </span>
      <InboxRowMenu label={`Actions for ${requestNumberLabel(request)}`} onClick={(event) => {
        openRowMenu('review', request.key, { from: event.currentTarget, gap: 4, returnFocus: event.currentTarget });
      }} />
    </li>
  );
});

/** One select of the filter row; its first choice is no filter. */
function Pick({ label, any, value, choices, onChange }: { label: string; any: string; value: string; choices: readonly (string | { value: string; label: string })[]; onChange: (value: string) => void }) {
  const options = choices.map((choice) => typeof choice === 'string' ? { value: choice, label: choice } : choice);
  return (
    <select aria-label={label} className={`form-control inbox-pick${value ? ' set' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{any}</option>
      {value && !options.some((option) => option.value === value) && <option value={value}>{value}</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

const APPROVAL_CHOICES = REVIEW_APPROVAL.filter((a) => a !== 'any').map((a) => ({ value: a, label: REVIEW_APPROVAL_LABEL[a] }));
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
const SORT_OPTIONS = REVIEW_SORT_BY.flatMap((by) => [true, false].map((descending) => ({ by, descending })));

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
  const sessions = useApp((s) => s.workspace?.sessions);
  const startedKeys = useMemo(() => new Set(dismissed ? [] : (sessions ?? []).flatMap((s) => (s.review ? [s.review.key] : []))), [sessions, dismissed]);
  const groups = useMemo(() => splitStarted(sortReviews(everything, sort), startedKeys), [everything, sort, startedKeys]);
  const started = useMemo(() => filterReviews(groups.started, filters, names, now), [groups.started, filters, names, now]);
  const list = useMemo(() => filterReviews(groups.rest, filters, names, now), [groups.rest, filters, names, now]);
  const filtering = isFiltering(filters);
  const matchCount = started.length + list.length;
  const reviewing = allReviewing ? started : started.slice(0, REVIEWING_SHOWN);
  const shownUnread = useMemo(() => {
    const shown = new Set(list.map((r) => r.key));
    return dismissed ? [] : view.unread.filter((key) => shown.has(key));
  }, [list, view.unread, dismissed]);
  const all = () => void actions.dismissReviews(list.map((r) => r.key), !dismissed);
  const chip = (label: string, count: number, on: boolean, filter?: 'dismissed') => (
    <button type="button" className={`chip${on ? ' selected' : ''}`} aria-pressed={on} onClick={() => showLocal(filter ? { kind: 'code-reviews', filter } : { kind: 'code-reviews' })}>
      {label} <span className="chip-count">{count}</span>
    </button>
  );
  const allLabel = dismissed ? (filtering ? `Restore ${list.length} shown` : 'Restore all') : filtering ? `Dismiss ${list.length} shown` : groups.started.length > 0 ? 'Dismiss all not started' : 'Dismiss all';
  return (
    <div className="page column inbox-page">
      <PageHeader
        title="Code reviews"
        line="Reviews requested from you"
        actions={
          <>
            {shownUnread.length > 0 && (
              <button type="button" className="secondary-button small" onClick={() => void actions.markReviewsSeen(shownUnread, true, true)}>
                <CheckCheck aria-hidden /> {filtering || shownUnread.length !== view.unread.length ? `Mark ${shownUnread.length} read` : 'Mark all read'}
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
      <div className="inbox-controls">
        <div className="chips inbox-tabs" role="group" aria-label="Review view">
          {chip('Waiting', view.requests.length, !dismissed)}
          {chip('Dismissed', view.dismissed.length, dismissed, 'dismissed')}
        </div>
        {dismissed && <p className="inbox-view-note">Dismissed reviews are hidden from Waiting. Restore a review to bring it back.</p>}
        {everything.length > 0 && (
          <div className="inbox-toolbar" role="group" aria-label="Filter and sort reviews">
            <InboxSearch label="Search reviews" value={filters.text} onChange={(text) => setFilters({ ...filters, text })} />
            <Pick label="Who asked" any="Anyone" value={filters.who} choices={whoChoices(everything)} onChange={(who) => setFilters({ ...filters, who })} />
            <Pick label="Project" any="Any project" value={filters.place} choices={placeChoices(everything, names)} onChange={(place) => setFilters({ ...filters, place })} />
            <Pick label="Opened" any={REVIEW_WITHIN_LABEL.any} value={filters.within === 'any' ? '' : filters.within} choices={WITHIN_CHOICES} onChange={(within) => setFilters({ ...filters, within: (within || 'any') as ReviewWithin })} />
            <Pick label="Approved" any={REVIEW_APPROVAL_LABEL.any} value={filters.approval === 'any' ? '' : filters.approval} choices={APPROVAL_CHOICES} onChange={(approval) => setFilters({ ...filters, approval: (approval || 'any') as ReviewApproval })} />
            {everything.length > 1 && (
              <select
                aria-label="Sort reviews"
                className="form-control inbox-pick set inbox-sort"
                value={`${sort.by}-${sort.descending}`}
                onChange={(event) => changeSort(SORT_OPTIONS[event.target.selectedIndex] ?? sort)}
              >
                {SORT_OPTIONS.map((option) => {
                  const key = `${option.by}-${option.descending}`;
                  return <option key={key} value={key}>{REVIEW_SORT_LABEL[option.by]} · {sortDirectionLabel(option).toLowerCase()}</option>;
                })}
              </select>
            )}
          </div>
        )}
        {filtering && everything.length > 0 && (
          <div className="inbox-filter-summary">
            <span role="status">{matchCount} of {everything.length} reviews</span>
            <button type="button" className="link-button" onClick={() => setFilters(NO_REVIEW_FILTERS)}>Clear filters</button>
          </div>
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
      {started.length > 0 && (
        <section className="page-section">
          <h2>Reviewing <span className="section-count">· {started.length}</span></h2>
          <ul className="inbox-list">
            {reviewing.map((request) => <ReviewRow key={request.key} request={request} dismissed={false} />)}
          </ul>
          {started.length > REVIEWING_SHOWN && (
            <button type="button" className="link-button inbox-show-all" onClick={() => setAllReviewing(!allReviewing)}>
              {allReviewing ? `Show the first ${REVIEWING_SHOWN}` : `Show all ${started.length}`}
            </button>
          )}
        </section>
      )}
      {everything.length === 0 ? (
        <Empty dismissed={dismissed} off={off} />
      ) : matchCount === 0 ? (
        <div className="empty">
          <h2>No review matches these filters</h2>
        </div>
      ) : list.length > 0 && (
        <section className="page-section">
          {groups.started.length > 0 && <h2>Not started <span className="section-count">· {list.length}</span></h2>}
          <ul className="inbox-list">
            {list.map((request) => <ReviewRow key={request.key} request={request} dismissed={dismissed} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
