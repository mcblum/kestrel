// Copying set-up values between computers (docs/designs/onboarding.md, section 19), the parts drawn here:
// another computer's request, answered with Allow or Deny at the top of Set up this computer and of
// Settings → Connections (19.7); the button on a line's missing-values row (19.4); and the names-only
// list of what this computer sent (19.14). Every word comes from shared/setup-values.ts; no value is
// ever on this page.
import { useEffect, useState } from 'react';
import { Copy, KeyRound, LoaderCircle, Trash2 } from 'lucide-react';
import { copyOfferText, copyValuesLabel, olderText, sentRowText, type SentEntry, type SetupCopy, type ValueRequestView } from '@kestrel/server/setup-values';
import { agoText } from '@kestrel/server/when';
import { useResource } from '../data/resources.ts';
import { asSent, SENT_PATH, setupValues, useValueRequests } from '../setupValues.ts';
import { useMinuteNow } from '../useNow.ts';

/** Seconds left on a request, ticking while its card is up (view state only). */
function useSecondsLeft(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

const leftText = (seconds: number): string => (seconds === 0 ? 'Expired' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`);

function RequestCard({ request }: { request: ValueRequestView }) {
  const left = useSecondsLeft(request.expiresAt);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const answer = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    try {
      await setupValues.answer(request.id, allow, request.from.name);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="setup-value-request" aria-labelledby={`value-request-${request.id}`}>
      <div className="setup-value-request-heading">
        <KeyRound aria-hidden />
        <h2 id={`value-request-${request.id}`}>{request.from.name} asks for values from this computer</h2>
        <span className="settings-status" aria-live="off">{leftText(left)}</span>
      </div>
      <p className="settings-help">
        For the step <strong>{request.step}</strong>:
      </p>
      <ul className="setup-value-request-names">
        {request.names.map((name) => (
          <li key={name}>
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <p className="settings-help">They would be read {request.source}.</p>
      <p className="settings-help">Allow only if you are setting up {request.from.name} yourself, now.</p>
      <div className="setup-line-actions">
        <button type="button" className="primary-button small" disabled={busy !== null || left === 0} aria-busy={busy === 'allow'} onClick={() => void answer(true)}>
          {busy === 'allow' && <LoaderCircle className="is-running" aria-hidden />} {busy === 'allow' ? 'Sending…' : 'Allow'}
        </button>
        <button type="button" className="secondary-button small" disabled={busy !== null || left === 0} aria-busy={busy === 'deny'} onClick={() => void answer(false)}>
          {busy === 'deny' && <LoaderCircle className="is-running" aria-hidden />} {busy === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
    </section>
  );
}

/**
 * Every request waiting on this computer's person; nothing when there is none. Drawn once, at the top of the
 * main canvas whatever page or session is open (App.tsx), so it is seen where the person is: it waits two minutes.
 */
export function ValueRequestCards() {
  const requests = useValueRequests();
  if (requests.length === 0) return null;
  return (
    <div className="setup-value-requests">
      {requests.map((r) => (
        <RequestCard key={r.id} request={r} />
      ))}
    </div>
  );
}

/** The Copy values button(s) on a line's missing-values row: one per computer that has some of them. */
export function CopyValuesButtons({ line, copy }: { line: string; copy: SetupCopy }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (from: string) => {
    setBusy(from);
    try {
      await setupValues.copy(line, from);
    } finally {
      setBusy(null);
    }
  };
  const several = copy.offers.length > 1;
  return (
    <span className="setup-line-actions setup-copy-values">
      {copy.offers.map((offer) => (
        <button
          key={offer.id}
          type="button"
          className="secondary-button small"
          disabled={offer.older || busy !== null}
          aria-busy={busy === offer.id}
          title={offer.older ? olderText(offer.name) : several ? copyOfferText(offer, copy.missing) : undefined}
          onClick={() => void run(offer.id)}
        >
          {busy === offer.id ? <LoaderCircle className="is-running" aria-hidden /> : <Copy aria-hidden />} {busy === offer.id ? `Waiting for Allow on ${offer.name}…` : copyValuesLabel(offer)}
        </button>
      ))}
      {busy !== null && (
        <span className="setup-line-needs-note" role="status">
          {copy.offers.find((o) => o.id === busy)?.name ?? 'That computer'} is showing the request at the top of its Kestrel window. Press Allow there within two minutes.
        </span>
      )}
      {copy.offers.filter((o) => o.older).map((o) => (
        <span key={o.id} className="setup-line-needs-note">
          {olderText(o.name)}
        </span>
      ))}
    </span>
  );
}

function SentRow({ entry, now }: { entry: SentEntry; now: number }) {
  return (
    <li>
      {sentRowText(entry)} · {agoText(entry.at, now)}
    </li>
  );
}

/** Settings → Connections: what this computer sent to others, names only (19.14). */
export function ValuesSentList() {
  const { value } = useResource(SENT_PATH, asSent);
  const now = useMinuteNow();
  if (value.state !== 'ready' || value.value.length === 0) return null;
  return (
    <section className="settings-section setup-values-sent">
      <div className="setup-values-sent-heading">
        <h2>Values copied to other computers</h2>
        <button type="button" className="secondary-button small" onClick={() => void setupValues.clearSent()}>
          <Trash2 aria-hidden /> Clear
        </button>
      </div>
      <p className="settings-help">Names only: what was sent is never kept here.</p>
      <ul className="setup-values-sent-list">
        {value.value.map((entry) => (
          <SentRow key={`${entry.at}-${entry.to.id}-${entry.line}`} entry={entry} now={now} />
        ))}
      </ul>
    </section>
  );
}
