// Settings → Workflow: "Other devices may start sessions on this computer" (server: remote-starts/;
// kestrel-connect.md, "Actions"; A8 in the account design). On by default. A switch saves as it is changed.
import { SettingSection } from './SettingHelp.tsx';
import { thisComputer } from '../platform.ts';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

export const REMOTE_STARTS_PATH = '/api/remote-starts';
interface RemoteStartPrefs {
  allowed: boolean;
}
const asPrefs = (raw: unknown): Sourced<RemoteStartPrefs> => ready(raw as RemoteStartPrefs);

function RemoteStartsControls() {
  const loaded = useResource(REMOTE_STARTS_PATH, asPrefs).value;
  const change = async (allowed: boolean) => {
    const prefs = await act(() => call<RemoteStartPrefs>(REMOTE_STARTS_PATH, { method: 'PATCH', body: JSON.stringify({ allowed }) }));
    if (prefs) putResource(REMOTE_STARTS_PATH, ready(prefs));
  };
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return (
    <label className="tag-rule-switch">
      <input type="checkbox" checked={loaded.value.allowed} onChange={(e) => void change(e.target.checked)} />
      Other devices may start sessions on {thisComputer()}
    </label>
  );
}

const HELP = (
  <p className="settings-help">
    A phone in your Kestrel Connect account can start a session here: a new one in a project, with an agent or preset and Manual or Auto, or a review of a pull request or work on a ticket, as the buttons on this computer do. The session runs on {thisComputer()}, and never in
    Bypass: a Bypass choice starts in Auto instead. Turn this off to refuse starts from other devices; they can still read, reply and answer.
  </p>
);

export function RemoteStartsSetting() {
  return (
    <SettingSection title="Starts from other devices" help={HELP}>
      <RemoteStartsControls />
    </SettingSection>
  );
}
