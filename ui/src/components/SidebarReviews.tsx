// The sidebar's CODE REVIEWS section: the pull and merge requests somebody asked the user to
// review, as the server pushes them (store.ts, `reviewRequests`).
//   - A request nobody has started on is a request row: its title, then its project (or
//     repository), number and who asked. A click opens it as a page, where the review is started.
//   - A request with a review session is that session's own row, in every way a session row (the
//     Sidebar's, through `renderSession`), with the same second line. The session has left its
//     usual place for this one (shared/pinned-homes.ts), so nothing is drawn twice.
//   - A pinned request, or one whose review session is pinned, is under PINNED and has no row here.
// Every row has a status mark: a request row its own (`requestStatus`), a session row the session's.
// The order is the session order chosen in Settings: most recently changed first, or the order the
// rows were dragged into (`inSidebarOrder`). In a custom order a row dropped above or below
// another takes that place; a pinned one dropped here is unpinned too. Not drawn while empty.
import { memo, useMemo, type DragEvent, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import type { TreeNode } from '@kestrel/server/model';
import type { ReviewRow as SessionRow } from '@kestrel/server/pinned-homes';
import { isPinned } from '@kestrel/server/pins';
import { inSidebarOrder, placeReview, requestNumberLabel, requestStatus, reviewRowDetail, type ReviewRequest } from '@kestrel/server/review-requests';
import { REVIEW_MIME, SESSION_MIME } from '../labels.ts';
import { openView, opener, type Route } from '../route.ts';
import { actions, appStore, useApp } from '../store.ts';
import { useSessionOrder } from '../tabsStore.ts';
import { Heading, useSectionOpen } from './SidebarHeading.tsx';
import { carries, InReviews, startDrag, useEdgeTarget } from './sidebarDrag.ts';

const DOT_CLASS = { idle: 'idle', 'needs-you': 'amber' } as const;

/** A request with no review session yet, as a row: in CODE REVIEWS, or under PINNED when it is pinned. */
export const ReviewRequestRow = memo(function ReviewRequestRow({ request, active }: { request: ReviewRequest; active: boolean }) {
  const projectName = useApp((s) => (request.projectId ? s.workspace?.projects.find((p) => p.id === request.projectId)?.name : undefined));
  const detail = reviewRowDetail(request, projectName);
  const status = requestStatus(request);
  return (
    <button
      type="button"
      className={`side-link review-link${active ? ' active' : ''}`}
      title={`${request.title}\n${request.repository} ${requestNumberLabel(request)}`}
      draggable
      onDragStart={startDrag(REVIEW_MIME, request.key)}
      data-menu-kind="review"
      data-menu-id={request.key}
      {...opener((newTab) => openView({ kind: 'review-request', id: request.key }, newTab))}
    >
      <Eye aria-hidden />
      <span className="review-label">
        <span className="review-title">{request.title}</span>
        <span className="review-detail">{detail}</span>
      </span>
      <span className={`status-dot row-dot ${DOT_CLASS[status.tone]}`} role="img" aria-label={status.label} title={status.label} />
    </button>
  );
});

type Row = { kind: 'request'; request: ReviewRequest } | { kind: 'session'; request: ReviewRequest; node: TreeNode };

/** The key of the request a dropped row stands for: a request row's own, or the one a dropped session reviews. */
function droppedKey(event: DragEvent): string | null {
  const key = event.dataTransfer.getData(REVIEW_MIME);
  if (key) return key;
  const sessionId = event.dataTransfer.getData(SESSION_MIME);
  return (sessionId && appStore.get().workspace?.sessions.find((s) => s.id === sessionId)?.review?.key) || null;
}

/** A row that came from PINNED goes back to this list: its pin, as a request or as a session, is removed. */
function unpin(event: DragEvent, key: string): void {
  const pins = appStore.get().workspace?.pins ?? [];
  if (isPinned(pins, 'review', key)) void actions.setPinned('review', key, false);
  const sessionId = event.dataTransfer.getData(SESSION_MIME);
  if (sessionId && isPinned(pins, 'session', sessionId)) void actions.setPinned('session', sessionId, false);
}

/** One row with a drop line above or below it, in a custom order. */
function ReviewSlot({ rowKey, keys, reorders, children }: { rowKey: string; keys: readonly string[]; reorders: boolean; children: ReactNode }) {
  const target = useEdgeTarget(
    (event) => reorders && (carries(event, REVIEW_MIME) || carries(event, SESSION_MIME)),
    (event, after) => {
      const key = droppedKey(event);
      if (!key) return; // a session that reviews nothing has no place here
      unpin(event, key);
      if (key !== rowKey) void actions.orderReviews(placeReview(keys, key, rowKey, after));
    },
  );
  return (
    <div className={`pin-slot${target.edge ? ` drop-${target.edge}` : ''}`} {...target.props}>
      {children}
    </div>
  );
}

interface Props {
  route: Route | null;
  /** The review sessions drawn here (shared/pinned-homes.ts `reviews`). */
  rows: readonly SessionRow[];
  activeId: string | null;
  renderSession: (node: TreeNode) => ReactNode;
}

export function SidebarReviews({ route, rows, activeId, renderSession }: Props) {
  const requests = useApp((s) => s.reviewRequests.requests);
  const order = useApp((s) => s.reviewRequests.order);
  const sessions = useApp((s) => s.workspace?.sessions);
  const pins = useApp((s) => s.workspace?.pins);
  const open = useSectionOpen('reviews');
  const reorders = useSessionOrder() === 'custom';
  // In the section's order: the session reviewing each request when it is drawn here, its request
  // row when nobody has started, and nothing when it is drawn under PINNED.
  const list = useMemo((): Row[] => {
    const nodes = new Map(rows.map((row) => [row.id, row.node]));
    return inSidebarOrder(requests, order, reorders).flatMap((request): Row[] => {
      const reviewing = (sessions ?? []).filter((s) => s.review?.key === request.key);
      const drawn = reviewing.flatMap((s) => nodes.get(s.id) ?? []);
      if (drawn.length > 0) return drawn.map((node) => ({ kind: 'session', request, node }));
      return reviewing.length > 0 || isPinned(pins ?? [], 'review', request.key) ? [] : [{ kind: 'request', request }];
    });
  }, [requests, order, reorders, sessions, rows, pins]);
  // What a drop reorders: every request's key in the order drawn, the pinned ones included, so they keep their place.
  const keys = useMemo(() => inSidebarOrder(requests, order, reorders).map((r) => r.key), [requests, order, reorders]);
  if (list.length === 0) return null;
  const shown = route?.view.kind === 'review-request' ? route.view.id : null;
  // Folded: what is open stays in sight, as the open session does in every other section.
  const visible = open ? list : list.filter((row) => (row.kind === 'request' ? row.request.key === shown : treeHolds(row.node, activeId)));
  return (
    <>
      <Heading title="CODE REVIEWS" id="reviews" />
      <InReviews.Provider value>
        {visible.map((row) => (
          <ReviewSlot key={row.kind === 'request' ? row.request.key : row.node.sessionId} rowKey={row.request.key} keys={keys} reorders={reorders}>
            {row.kind === 'request' ? <ReviewRequestRow request={row.request} active={row.request.key === shown} /> : <ul className="tree flat">{renderSession(row.node)}</ul>}
          </ReviewSlot>
        ))}
      </InReviews.Provider>
    </>
  );
}

const treeHolds = (node: TreeNode, id: string | null): boolean => id !== null && (node.sessionId === id || node.children.some((child) => treeHolds(child, id)));
