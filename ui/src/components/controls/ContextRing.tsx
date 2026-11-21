// A small ring that fills with the share of the session's context window in use. Clicking it opens
// a popup above it with the numbers the agent gave: tokens used of the window, and the breakdown.
// The measurement is taken as each turn ends (it arrives on the live channel) and, for a session
// that has not run a turn since the server started, asked once when the session is shown.
import { useEffect, useRef, useState } from 'react';
import { percentLabel, shownRows, tokenCount, usedFraction, type ContextUsage } from '@kestrel/server/context-usage';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../../data/resources.ts';
import { useApp } from '../../store.ts';

/** GET /api/sessions/:id/context: how full the window is, null when it cannot be known now. */
const asContextUsage = (raw: unknown): Sourced<ContextUsage | null> => ready((raw as { usage?: ContextUsage | null })?.usage ?? null);
import { Popup } from '../Popup.tsx';

const R = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * R;
/** From here the ring is drawn in the warning colour: the window is nearly full. */
const NEARLY_FULL = 0.8;

function Ring({ fraction }: { fraction: number }) {
  return (
    <svg className="ctx-ring" viewBox="0 0 14 14" aria-hidden>
      <circle className="ctx-track" cx="7" cy="7" r={R} />
      {fraction > 0 && <circle className="ctx-fill" cx="7" cy="7" r={R} strokeDasharray={`${Math.max(0.6, fraction * CIRCUMFERENCE)} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />}
    </svg>
  );
}

function Breakdown({ usage }: { usage: ContextUsage }) {
  const { inWindow, deferred } = shownRows(usage);
  return (
    <>
      <div className="ctx-total">
        <strong>{tokenCount(usage.usedTokens)}</strong> of {tokenCount(usage.windowTokens)} tokens · {percentLabel(usage)}
      </div>
      {inWindow.length > 0 && (
        <dl className="ctx-rows">
          {inWindow.map((r) => (
            <div key={r.name} className={`ctx-row ${r.kind}`}>
              <dt>{r.name}</dt>
              <dd>{tokenCount(r.tokens)}</dd>
            </div>
          ))}
        </dl>
      )}
      {deferred.length > 0 && (
        <>
          <div className="ctx-sub" title="Loaded only when the agent needs them, so they are not in the window">Not in the window</div>
          <dl className="ctx-rows">
            {deferred.map((r) => (
              <div key={r.name} className="ctx-row deferred">
                <dt>{r.name}</dt>
                <dd>{tokenCount(r.tokens)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="ctx-foot">
        {usage.model} · measured {new Date(usage.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </>
  );
}

/** The ring for a running session. `sessionId` decides which measurement it shows. */
export function ContextRing({ sessionId }: { sessionId: string }) {
  const live = useApp((s) => s.live.get(sessionId)?.context ?? null);
  const asked = useResource(`/api/sessions/${encodeURIComponent(sessionId)}/context`, asContextUsage).value;
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const usage = live ?? (asked.state === 'ready' ? asked.value : null);
  const pending = !live && asked.state === 'loading';

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false), host.current?.querySelector('button')?.focus());
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const fraction = usage ? usedFraction(usage) : 0;
  const label = usage ? `Context window: ${percentLabel(usage)} used` : 'Context window: not measured yet';
  return (
    <span className="ctl ctl-context" ref={host}>
      <button ref={button} type="button" className={`ctl-button ctx-button${fraction >= NEARLY_FULL ? ' nearly-full' : ''}`} aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <Ring fraction={fraction} />
      </button>
      {open && (
        <Popup anchor={button} side="above" gap={6} className="ctx-pop" role="dialog" aria-label="Context window">
          <div className="ctx-title">Context window</div>
          {usage ? <Breakdown usage={usage} /> : <p className="ctx-none">{pending ? 'Asking the agent…' : 'Not measured yet. It is measured each time a turn ends.'}</p>}
        </Popup>
      )}
    </span>
  );
}
