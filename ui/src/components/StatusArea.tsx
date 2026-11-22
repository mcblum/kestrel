// A one-line status row near the bottom of the sidebar, shown only when something is not
// working: the server is unreachable, or no agent can start a session. Clicking it lists what
// is and is not connected. When all is well there is no row at all.
import { useEffect, useRef, useState } from 'react';
import { Popup } from './Popup.tsx';
import { SignIn } from './SignIn.tsx';
import { useConnections, type ConnectionRow } from './useAgents.ts';

export function ConnectionList({ rows }: { rows: ConnectionRow[] }) {
  return (
    <ul className="connection-list">
      {rows.map((r) => (
        <li key={r.name} className={r.signIn ? 'with-sign-in' : undefined}>
          <span className={`status-dot ${r.connected ? 'green' : 'idle'}`} />
          <span>{r.name}</span>
          <small title={r.detail}>{r.note}</small>
          {r.signIn && (
            <div className="connection-sign-in">
              <p className="settings-help">{r.detail}</p>
              <SignIn agent={r.signIn} small />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StatusArea() {
  const { live, known, rows } = useConnections();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  // Nothing to say while the server is up and at least one agent can start a session.
  const working = live && (!known || rows.slice(1).some((r) => r.connected));
  if (working) return null;
  return (
    <div className="status-area" ref={host}>
      <button ref={button} type="button" className="status-line" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`status-dot ${live ? 'green' : 'amber'}`} />
        <span role="status" aria-live="polite">
          {live ? 'No agent connected' : 'Reconnecting…'}
        </span>
      </button>
      {open && (
        <Popup anchor={button} side="above" gap={6} className="status-pop" role="dialog" aria-label="Connections">
          <ConnectionList rows={rows} />
        </Popup>
      )}
    </div>
  );
}
