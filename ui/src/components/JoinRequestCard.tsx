// Another device asking to be let into the account (kestrel-connect.md, "Account stage 1 as built"): who is asking,
// Let in, the six boxes for the code it shows, Allow and Not me, then the second code to type there. One card, drawn
// in Settings → Connections and over any page (JoinRequestOverlay.tsx; issue 72), so its rules are written once. All it
// shows is the server's `ConnectJoinRequest` from the store's `connect` slice; what to do next is the server's
// (connect/link/join.ts): the six digits typed here, three tries, the second code, never on sign-in alone.
import { useState, type ReactNode } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { joinRequestTitle, type ConnectJoinRequest } from '@kestrel/server/connect';
import { connectActions } from '../connectStore.ts';

/** A time of day, as a request's limit is said. */
export const untilText = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Whether the person still has something to do on a request here (not only to read what happened). */
const isOpen = (request: ConnectJoinRequest): boolean => request.state !== 'showing' && request.state !== 'done';

function CodeForm({ request }: { request: ConnectJoinRequest }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="connect-join-form"
      onSubmit={(e) => {
        e.preventDefault();
        void connectActions.typeCode(request.id, code).then((ok) => ok && setCode(''));
      }}
    >
      <label className="settings-help" htmlFor={`join-code-${request.id}`}>
        Type the code {request.name} shows
      </label>
      <input id={`join-code-${request.id}`} className="form-control connect-join-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      <button type="submit" className="primary-button small" disabled={code.replace(/\D/g, '').length !== 6}>
        Allow
      </button>
    </form>
  );
}

function Detail({ request }: { request: ConnectJoinRequest }) {
  if (request.state === 'done') return <span className="settings-help" role="status">{request.outcome}</span>;
  if (request.state === 'showing') {
    return (
      <>
        <span className="settings-help">{request.name} is let in. To finish, type this code on {request.name}:</span>
        <code className="connect-join-code">{request.code}</code>
      </>
    );
  }
  if (request.state === 'typing') return <CodeForm request={request} />;
  return <span className="settings-help">{request.state === 'opening' ? `Waiting for ${request.name}…` : request.state === 'letting-in' ? `Letting ${request.name} in…` : `Open until ${untilText(request.expiresAt)}. Let it in only if you are setting it up now.`}</span>;
}

export interface JoinRequestCardProps {
  request: ConnectJoinRequest;
  /** `li` in Settings → Connections' list; `section` over a page. */
  as: 'li' | 'section';
  /** The heading's id, for a card that names a dialog. */
  titleId?: string;
  /** Drawn after the card's own buttons (the overlay's Put aside). */
  extra?: ReactNode;
}

/** Another device asking to be let in: Let in, the code it shows, Allow; or Not me. */
export function JoinRequestCard({ request, as: Tag, titleId, extra }: JoinRequestCardProps) {
  const Icon = request.kind === 'phone' ? Smartphone : Monitor;
  return (
    <Tag className="connect-join-request">
      <Icon className="connect-device-icon" aria-hidden />
      <div className="connect-device-detail">
        <span className="connect-device-name" id={titleId}>
          {isOpen(request) ? joinRequestTitle(request) : request.name}
        </span>
        <Detail request={request} />
        {request.problem && (
          <span className="settings-help" role="alert">
            {request.problem}
          </span>
        )}
      </div>
      {request.state === 'waiting' && (
        <button type="button" className="secondary-button small" onClick={() => void connectActions.openRequest(request.id)}>
          Let in
        </button>
      )}
      {!isOpen(request) && (
        <button type="button" className="secondary-button small" onClick={() => void connectActions.dismissRequest(request.id)}>
          Done
        </button>
      )}
      {isOpen(request) && request.state !== 'letting-in' && (
        <button type="button" className="secondary-button small" onClick={() => void connectActions.refuseRequest(request.id)}>
          Not me
        </button>
      )}
      {extra}
    </Tag>
  );
}
