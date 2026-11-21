// One request the user was asked to review, as a page: what it is, who opened it, which project it
// belongs to, and its description. It reads the one copy the server pushed (`reviewRequests`); a
// request no longer there has been reviewed, merged, closed or taken back. One the user dismissed
// is still shown, saying so, with Restore in place of Dismiss.
import { useEffect, useState } from 'react';
import { ExternalLink, Eye, FolderPlus, RotateCcw, X } from 'lucide-react';
import { hostTerms } from '@kestrel/server/host-terms';
import { openedText, requestNumberLabel } from '@kestrel/server/review-requests';
import { Markdown } from '../components/Markdown.tsx';
import { openCreateProject } from '../projectNav.ts';
import { openSession, openView, opener } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { useMinuteNow } from '../useNow.ts';
import { PageHeader } from './PageHeader.tsx';

export function ReviewRequestPage({ id }: { id: string }) {
  const waiting = useApp((s) => s.reviewRequests.requests.find((r) => r.key === id));
  const dismissed = useApp((s) => s.reviewRequests.dismissed.find((r) => r.key === id));
  const request = waiting ?? dismissed;
  const project = useApp((s) => (request?.projectId ? s.workspace?.projects.find((p) => p.id === request.projectId) : undefined));
  // The session already reviewing it, wherever it is drawn: a request has one review at a time.
  const reviewId = useApp((s) => s.workspace?.sessions.find((session) => session.review?.key === id)?.id);
  const now = useMinuteNow();
  const opened = request ? openedText(request, now) : '';
  const [starting, setStarting] = useState(false);
  // Opening a request is reading it.
  const unread = useApp((s) => s.reviewRequests.unread.includes(id));
  useEffect(() => {
    if (unread) void actions.markReviewsSeen([id], true);
  }, [id, unread]);
  const start = async (newTab: boolean) => {
    if (reviewId) return void openSession(reviewId, newTab);
    setStarting(true);
    const session = await actions.startReview(id);
    setStarting(false);
    if (session) openSession(session.id, newTab);
  };
  if (!request)
    return (
      <div className="page column collection">
        <div className="empty">
          <h2>This review is no longer waiting on you</h2>
          <p>It was reviewed, merged, closed, or the request was taken back.</p>
        </div>
      </div>
    );
  const terms = hostTerms(request.host);
  const where = `${request.repository} ${requestNumberLabel(request)}`;
  return (
    <div className="page column collection review-page">
      <PageHeader
        title={request.title}
        line={[`${terms.longTitle} ${where}`, request.author ? `opened by ${request.author}${opened ? ` ${opened}` : ''}` : opened && `opened ${opened}`, request.requestedBy && `review asked by ${request.requestedBy}`].filter(Boolean).join(' · ')}
        actions={
          <>
            {request.url && (
              <a className="secondary-button small" href={request.url} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden /> Open on {terms.service}
              </a>
            )}
            <button type="button" className="secondary-button small" onClick={() => void actions.dismissReviews([id], !dismissed)}>
              {dismissed ? <RotateCcw aria-hidden /> : <X aria-hidden />} {dismissed ? 'Restore' : 'Dismiss'}
            </button>
            {(project || reviewId) && (
              <button type="button" className="primary-button small" disabled={starting} {...opener((newTab) => void start(newTab))}>
                <Eye aria-hidden /> {reviewId ? 'Open review' : starting ? 'Starting…' : 'Start review'}
              </button>
            )}
          </>
        }
      />
      {dismissed && <p className="review-dismissed-note">You dismissed this request. It is not listed as waiting on you, and no review of it starts on its own.</p>}
      <section className="page-section">
        <h2>Project</h2>
        {project ? (
          <button type="button" className="review-project" {...opener((newTab) => openView({ kind: 'project', id: project.id }, newTab))}>
            {project.name}
          </button>
        ) : (
          <p className="review-no-project">
            {request.repository} is not a project in Kestrel, so it cannot be checked out here.
            <button type="button" className="secondary-button small" {...opener((newTab) => openCreateProject(newTab))}>
              <FolderPlus aria-hidden /> Add project
            </button>
          </p>
        )}
      </section>
      {request.notStarted && !reviewId && (
        <section className="page-section">
          <h2>Not started on its own</h2>
          <p className="review-not-started">{request.notStarted}</p>
        </section>
      )}
      <section className="page-section">
        <h2>Description</h2>
        {request.body ? (
          <div className="prose review-body">
            <Markdown text={request.body} />
          </div>
        ) : (
          <p className="quiet">No description.</p>
        )}
      </section>
    </div>
  );
}
