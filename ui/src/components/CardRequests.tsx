// Pull requests in a session's hover card (SessionCard.tsx), one design wherever a card lists one
// (Matt, 2026-11-24):
//   - `CardRequestIcon`: the request icon in its status colour, with the row mark's cross when it needs the
//     user, so the line reads without colour too; its words stay beside it.
//   - `BroughtInCardLines`: the requests of the sessions this one brought in, drawn as its children,
//     indented on the sidebar's elbow under its own request (or under the card's heading when it has
//     none), needs-you first, as the derived fact orders them (@kestrel/server/brought-in-requests). Each
//     opens in its own session. Read from the store's one copy (useBroughtIn); nothing is asked for here.
import { GitPullRequest, X } from 'lucide-react';
import type { BroughtInRequest } from '@kestrel/server/brought-in-requests';
import { hostTerms, requestNumber } from '@kestrel/server/host-terms';
import type { RequestTone } from '@kestrel/server/row-slot';
import { useBroughtIn } from '../broughtIn.ts';
import { hoverCard } from '../hoverCardState.ts';
import { opener, openSession } from '../route.ts';
import { openPullRequest } from '../sessionView.ts';

/** How many of the brought-in requests a card lists before "and N more". */
export const CARD_REQUEST_LIMIT = 5;

export function CardRequestIcon({ tone, alert = false }: { tone: RequestTone; alert?: boolean }) {
  return (
    <span className={`card-pr-icon pr-tone-${tone}`} aria-hidden>
      <GitPullRequest />
      {alert && <X className="row-icon-alert" />}
    </span>
  );
}

function ChildLine({ request }: { request: BroughtInRequest }) {
  const { pr, sessionId } = request;
  const number = requestNumber(hostTerms(request.host), pr.number);
  return (
    <button
      type="button"
      className="menu-item card-line card-child"
      title={`${number} ${pr.title} · ${request.label} · in ${request.sessionTitle}`}
      {...opener((newTab) => (hoverCard.close(), openPullRequest(sessionId, pr), openSession(sessionId, newTab)))}
    >
      <CardRequestIcon tone={request.tone} alert={request.needsYou} />
      <span className="card-child-text">
        <span className="card-text">
          {number} {pr.title}
        </span>
        <span className="card-text card-child-where">
          {request.label} · {request.sessionTitle}
        </span>
      </span>
    </button>
  );
}

export function BroughtInCardLines({ sessionId, underOwn }: { sessionId: string; underOwn: boolean }) {
  const rollup = useBroughtIn(sessionId);
  if (!rollup) return null;
  const shown = rollup.requests.slice(0, CARD_REQUEST_LIMIT);
  const more = rollup.requests.length - shown.length;
  return (
    <div className={`card-children${underOwn ? ' under-own' : ''}`}>
      {shown.map((r) => (
        <ChildLine key={`${r.sessionId}:${r.pr.number}`} request={r} />
      ))}
      {more > 0 && <div className="card-line card-muted card-child card-more">and {more} more</div>}
    </div>
  );
}
