// Settings → Tickets → Sources → Linear: Not connected / Connected as <name>, Disconnect. Connecting is
// a pasted personal API key, so it is a draft saved by the screen's one Save bar; the server asks
// Linear who the key is before keeping anything, and its refusal shows under the field. The key is
// never sent back to the page. The view is a route answer held once in the store (`useResource`).
import { useId, useState } from 'react';
import { ExternalLink, Unplug } from 'lucide-react';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { thisComputer } from '../platform.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { useDraft } from '../unsaved.ts';
import { SettingRow } from './SettingRow.tsx';

const LINEAR_PATH = '/api/tickets/linear';

interface LinearView {
  connected: boolean;
  name: string | null;
  storage: 'keystore' | 'file';
  unavailable: string | null;
}

const asView = (raw: unknown): Sourced<LinearView> => ready(raw as LinearView);

function ConnectForm({ view, changed: onChanged }: { view: LinearView; changed?: () => void }) {
  const id = useId();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const next = await call<LinearView>(LINEAR_PATH, { method: 'PUT', body: JSON.stringify({ key }) });
      putResource(LINEAR_PATH, ready(next));
      onChanged?.();
      setKey('');
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const anchor = useDraft({ what: 'Linear connection', changed: Boolean(key.trim()), problem: null, save, discard: () => (setKey(''), setError(null)) });
  if (view.unavailable) return <p className="settings-help">{view.unavailable}</p>;
  return (
    <>
      <SettingRow label="Personal API key" htmlFor={`${id}-key`}>
        <input id={`${id}-key`} className="form-control" type="password" autoComplete="off" spellCheck={false} placeholder="Paste a key" value={key} onChange={(e) => (setKey(e.target.value), setError(null))} />
      </SettingRow>
      <span ref={anchor} className="draft-anchor" />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-help">
        Make a key in Linear under{' '}
        <a href="https://linear.app/settings/account/security" target="_blank" rel="noreferrer">
          Settings → Security & access → Personal API keys <ExternalLink aria-hidden />
        </a>
        . Kestrel lists the issues assigned to you with their cycle, description and comments, and moves one to another state when you pick it.
      </p>
    </>
  );
}

/** Linear's connection: who it is connected as and Disconnect, or the field to paste a key. `changed` hears either. */
export function LinearControls({ changed }: { changed?: () => void }) {
  const loaded = useResource(LINEAR_PATH, asView).value;
  const [busy, setBusy] = useState(false);
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const view = loaded.value;
  const disconnect = async () => {
    setBusy(true);
    const next = await act(() => call<LinearView>(LINEAR_PATH, { method: 'DELETE' }));
    if (next) putResource(LINEAR_PATH, ready(next));
    changed?.();
    setBusy(false);
  };
  return (
    <>
      {view.connected ? (
        <div className="setting-row">
          <span>Connected as {view.name ?? 'your Linear account'}</span>
          <button type="button" className="secondary-button small" disabled={busy} onClick={() => void disconnect()}>
            <Unplug aria-hidden /> Disconnect
          </button>
        </div>
      ) : (
        <ConnectForm view={view} changed={changed} />
      )}
      {view.storage === 'file' && <p className="settings-help">There is no keychain Kestrel can use on {thisComputer()}, so the key is kept in a file only your user account can read.</p>}
    </>
  );
}
