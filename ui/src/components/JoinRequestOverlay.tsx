// A device asking to join the account, drawn over whatever page is open (issue 72): the same card Settings →
// Connections draws (JoinRequestCard.tsx), floating at the top of the main canvas, never a side panel and never a
// change of page. It can be put aside (its close button, or Escape inside it), which is this window's view state only:
// the request stays in Settings → Connections. It goes by itself when the request is answered on another device,
// withdrawn or runs out, because it is drawn from the store's `connect` slice, which the server pushes. On the
// Connections page the page's own card is enough, so nothing floats there.
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ConnectJoinRequest } from '@kestrel/server/connect';
import type { Route } from '../route.ts';
import { joinOverlay, usePutAside } from '../joinOverlay.ts';
import { useApp } from '../store.ts';
import { JoinRequestCard } from './JoinRequestCard.tsx';

const NONE: readonly ConnectJoinRequest[] = [];

/** Whether the page in front is Settings → Connections, which draws the requests itself. */
const onConnections = (route: Route | null): boolean => route?.view.kind === 'settings' && route.view.section === 'connections';

function Floating({ request }: { request: ConnectJoinRequest }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = `join-overlay-${request.id}`;
  // Reachable from the keyboard without taking it from someone typing: focused when it comes only if nothing else is.
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) ref.current?.focus();
  }, [request.id]);
  const putAside = (
    <button type="button" className="icon-button join-request-put-aside" aria-label="Put aside" title="Put aside. It stays in Settings → Connections." onClick={() => joinOverlay.putAside(request.id)}>
      <X aria-hidden />
    </button>
  );
  return (
    <div
      ref={ref}
      className="join-request-float"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        joinOverlay.putAside(request.id);
      }}
    >
      <JoinRequestCard request={request} as="section" titleId={titleId} putAside={putAside} />
    </div>
  );
}

export function JoinRequestOverlay({ route }: { route: Route | null }) {
  const requests = useApp((s) => s.connect?.requests ?? NONE);
  const aside = usePutAside();
  if (onConnections(route)) return null;
  const shown = requests.filter((r) => !aside.has(r.id));
  if (shown.length === 0) return null;
  return (
    <div className="join-request-anchor">
      <div className="join-request-overlay" role="region" aria-label="Devices asking to join your account">
        {shown.map((request) => (
          <Floating key={request.id} request={request} />
        ))}
      </div>
    </div>
  );
}
