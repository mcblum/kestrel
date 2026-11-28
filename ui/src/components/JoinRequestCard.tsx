// Another device asking to be let into the account (kestrel-connect.md, "Account stage 1 as built"): who is asking,
// Let in, the field for the code it shows, Allow and Not me, then the second code to type there. One card, drawn
// in Settings → Connections and over any page (JoinRequestOverlay.tsx; issue 72), so its rules are written once. All it
// shows is the server's `ConnectJoinRequest` from the store's `connect` slice; what to do next is the server's
// (connect/link/join.ts): the six digits typed here, three tries, the second code, never on sign-in alone.
import { useState, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle, Monitor, Smartphone } from 'lucide-react';
import { joinRequestTitle, type ConnectJoinRequest } from '@kestrel/server/connect';
import { connectActions } from '../connectStore.ts';

/** A time of day, as a request's limit is said. */
export const untilText = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Whether the person still has something to do on a request here (not only to read what happened). */
const isOpen = (request: ConnectJoinRequest): boolean => request.state !== 'showing' && request.state !== 'done';

function CodeForm({ request, problem, refuse }: { request: ConnectJoinRequest; problem: ReactNode; refuse: ReactNode }) {
  const [code, setCode] = useState('');
  const inputId = `join-code-${request.id}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void connectActions.typeCode(request.id, code).then((ok) => ok && setCode(''));
      }}
    >
      <div className="connect-join-body">
        <label htmlFor={inputId}>Type the code {request.name} shows</label>
        {problem}
      </div>
      <div className="connect-join-footer">
        <input id={inputId} className="form-control connect-join-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        <div className="connect-join-request-actions">
          <button type="submit" className="primary-button small" disabled={code.replace(/\D/g, '').length !== 6}>
            Allow
          </button>
          {refuse}
        </div>
      </div>
    </form>
  );
}

function Detail({ request }: { request: ConnectJoinRequest }) {
  if (request.state === 'done') return <p role="status">{request.outcome}</p>;
  if (request.state === 'showing') {
    return (
      <>
        <p>{request.name} is let in. To finish, type this code on {request.name}:</p>
        <code className="connect-join-code">{request.code}</code>
      </>
    );
  }
  if (request.state === 'opening' || request.state === 'letting-in') {
    return (
      <p className="connect-join-progress" role="status">
        <LoaderCircle aria-hidden />
        <span>{request.state === 'opening' ? `Waiting for ${request.name}…` : `Letting ${request.name} in…`}</span>
      </p>
    );
  }
  return <p>Open until {untilText(request.expiresAt)}. Let it in only if you are setting it up now.</p>;
}

export interface JoinRequestCardProps {
  request: ConnectJoinRequest;
  /** `li` in Settings → Connections' list; `section` over a page. */
  as: 'li' | 'section';
  /** The heading's id, for a card that names a dialog. */
  titleId?: string;
  /** The overlay's Put aside control, shown in the top corner. */
  putAside?: ReactNode;
}

/** Another device asking to be let in: Let in, the code it shows, Allow; or Not me. */
export function JoinRequestCard({ request, as: Tag, titleId, putAside }: JoinRequestCardProps) {
  const Icon = request.kind === 'phone' ? Smartphone : Monitor;
  const open = isOpen(request);
  const problem = request.problem && (
    <p className="connect-join-problem" role="alert">
      <CircleAlert aria-hidden />
      <span>{request.problem}</span>
    </p>
  );
  const refuse = (
    <button type="button" className="secondary-button small" onClick={() => void connectActions.refuseRequest(request.id)}>
      Not me
    </button>
  );
  return (
    <Tag className="connect-join-request">
      <header className="connect-join-header">
        <span className="connect-join-device" aria-hidden><Icon /></span>
        <h3 className="connect-join-heading" id={titleId}>
          {open ? joinRequestTitle(request) : request.name}
        </h3>
      </header>
      {request.state === 'typing' ? <CodeForm request={request} problem={problem} refuse={refuse} /> : (
        <>
          <div className="connect-join-body">
            <Detail request={request} />
            {problem}
          </div>
          {request.state !== 'letting-in' && (
            <div className="connect-join-footer">
              <div className="connect-join-request-actions">
                {request.state === 'waiting' && (
                  <button type="button" className="primary-button small" onClick={() => void connectActions.openRequest(request.id)}>
                    Let in
                  </button>
                )}
                {open ? refuse : (
                  <button type="button" className="secondary-button small" onClick={() => void connectActions.dismissRequest(request.id)}>
                    Done
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {putAside}
    </Tag>
  );
}
