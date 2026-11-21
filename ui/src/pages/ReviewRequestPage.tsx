// One request the user was asked to review, as a page: what it is, who opened it, which project it
// belongs to, and its description. It reads the one copy the server pushed (`reviewRequests`); a
// request no longer there has been reviewed, merged, closed or taken back.
import { useState } from 'react';
import { ExternalLink, Eye, FolderPlus } from 'lucide-react';
import { hostTerms } from '@kestrel/server/host-terms';
import { requestNumberLabel } from '@kestrel/server/review-requests';
import { Markdown } from '../components/Markdown.tsx';
import { openCreateProject } from '../projectNav.ts';
import { openSession, openView, opener } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { PageHeader } from './PageHeader.tsx';

export function ReviewRequestPage({ id }: { id: string }) {
  const request = useApp((s) => s.reviewRequests.requests.find((r) => r.key === id));
  const project = useApp((s) => (request?.projectId ? s.workspace?.projects.find((p) => p.id === request.projectId) : undefined));
  // The session already reviewing it, wherever it is drawn: a request has one review at a time.
  const reviewId = useApp((s) => s.workspace?.sessions.find((session) => session.review?.key === id)?.id);
  const [starting, setStarting] = useState(false);
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
        line={[`${terms.longTitle} ${where}`, request.author && `opened by ${request.author}`, request.requestedBy && `review asked by ${request.requestedBy}`].filter(Boolean).join(' · ')}
        actions={
          <>
            {request.url && (
              <a className="secondary-button small" href={request.url} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden /> Open on {terms.service}
              </a>
            )}
            {(project || reviewId) && (
              <button type="button" className="primary-button small" disabled={starting} {...opener((newTab) => void start(newTab))}>
                <Eye aria-hidden /> {reviewId ? 'Open review' : starting ? 'Starting…' : 'Start review'}
              </button>
            )}
          </>
        }
      />
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
