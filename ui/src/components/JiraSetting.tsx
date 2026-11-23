// Settings → Tickets → Sources → Jira Cloud (docs/designs/tickets.md, section 3): Not connected / Connected
// as <name>, Disconnect. Connecting is typed (the site, the account's email and a pasted API token),
// so it is a draft saved by the screen's one Save bar; the server asks Jira who the token is before
// keeping anything, and its refusal shows under the fields. The token is never sent back to the page.
// The view is a route answer held once in the store (`useResource`).
import { useId, useState } from 'react';
import { ExternalLink, Unplug } from 'lucide-react';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { thisComputer } from '../platform.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { useDraft } from '../unsaved.ts';
import { SettingRow } from './SettingRow.tsx';

const JIRA_PATH = '/api/tickets/jira';

interface JiraView {
  connected: boolean;
  site: string | null;
  email: string | null;
  name: string | null;
  storage: 'keystore' | 'file';
  unavailable: string | null;
}

const asView = (raw: unknown): Sourced<JiraView> => ready(raw as JiraView);
const EMPTY = { site: '', email: '', token: '' };

function ConnectForm({ view, changed: onChanged }: { view: JiraView; changed?: () => void }) {
  const id = useId();
  const [typed, setTyped] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const changed = Boolean(typed.site.trim() || typed.email.trim() || typed.token.trim());
  const save = async () => {
    try {
      const next = await call<JiraView>(JIRA_PATH, { method: 'PUT', body: JSON.stringify(typed) });
      putResource(JIRA_PATH, ready(next));
      onChanged?.();
      setTyped(EMPTY);
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const problem = changed && !(typed.site.trim() && typed.email.trim() && typed.token.trim()) ? 'Fill in the site, the email and the API token to connect Jira.' : null;
  const anchor = useDraft({ what: 'Jira connection', changed, problem, save, discard: () => (setTyped(EMPTY), setError(null)) });
  const field = (key: keyof typeof EMPTY, label: string, placeholder: string, type = 'text') => (
    <SettingRow label={label} htmlFor={`${id}-${key}`}>
      <input id={`${id}-${key}`} className="form-control" type={type} autoComplete="off" spellCheck={false} placeholder={placeholder} value={typed[key]} onChange={(e) => (setTyped({ ...typed, [key]: e.target.value }), setError(null))} />
    </SettingRow>
  );
  if (view.unavailable) return <p className="settings-help">{view.unavailable}</p>;
  return (
    <>
      {field('site', 'Site', 'your-team.atlassian.net')}
      {field('email', 'Account email', 'you@company.com', 'email')}
      {field('token', 'API token', 'Paste a token', 'password')}
      <span ref={anchor} className="draft-anchor" />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-help">
        Make a token at{' '}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
          id.atlassian.com → Security → API tokens <ExternalLink aria-hidden />
        </a>
        . Kestrel lists the issues assigned to you with their sprint, description and comments, and moves one through its workflow when you pick a status. Jira Cloud only: the site ends in atlassian.net (or jira.com), and the token goes nowhere else.
      </p>
    </>
  );
}

/** Jira Cloud's connection: who it is connected as and Disconnect, or the form to connect it. `changed` hears either. */
export function JiraControls({ changed }: { changed?: () => void }) {
  const loaded = useResource(JIRA_PATH, asView).value;
  const [busy, setBusy] = useState(false);
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const view = loaded.value;
  const disconnect = async () => {
    setBusy(true);
    const next = await act(() => call<JiraView>(JIRA_PATH, { method: 'DELETE' }));
    if (next) putResource(JIRA_PATH, ready(next));
    changed?.();
    setBusy(false);
  };
  return (
    <>
      {view.connected ? (
        <div className="setting-row">
          <span>
            Connected as {view.name ?? view.email} on {view.site}
          </span>
          <button type="button" className="secondary-button small" disabled={busy} onClick={() => void disconnect()}>
            <Unplug aria-hidden /> Disconnect
          </button>
        </div>
      ) : (
        <ConnectForm view={view} changed={changed} />
      )}
      {view.storage === 'file' && <p className="settings-help">There is no keychain Kestrel can use on {thisComputer()}, so the token is kept in a file only your user account can read.</p>}
    </>
  );
}
