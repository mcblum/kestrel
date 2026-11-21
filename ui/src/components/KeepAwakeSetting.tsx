// Settings → General → Keep awake (server: shared/keep-awake.ts, keep-awake/api.ts): one switch,
// off unless turned on, and a line saying what Kestrel is doing about it now. Held once in the app
// store through useResource; a change writes back what the server stored.
import { awakeText, type KeepAwakeView } from '@kestrel/server/keep-awake';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

const KEEP_AWAKE_PATH = '/api/keep-awake';
const asView = (raw: unknown): Sourced<KeepAwakeView> => ready(raw as KeepAwakeView);

function Controls() {
  const loaded = useResource(KEEP_AWAKE_PATH, asView).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const view = loaded.value;
  const change = async (enabled: boolean) => {
    const next = await act(() => call<KeepAwakeView>(KEEP_AWAKE_PATH, { method: 'PUT', body: JSON.stringify({ enabled }) }));
    if (next) putResource(KEEP_AWAKE_PATH, ready(next));
  };
  const now = awakeText(view.state, view.power);
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={view.enabled} disabled={!view.state.holding && view.state.why === 'unavailable' && !view.enabled} onChange={(e) => void change(e.target.checked)} />
        Keep this Mac awake while agents are working
      </label>
      {now && <p className="settings-help" role="status">{now}</p>}
    </>
  );
}

const HELP = (
  <p className="settings-help">
    While any session's agent is working, Kestrel stops this Mac going to sleep from being idle, so long work is not cut off; when none is working it sleeps as usual. The display may still turn off, and closing the lid still puts it to sleep. On battery below
    20% Kestrel stands aside and lets it sleep. Off unless you turn it on.
  </p>
);

export function KeepAwakeSetting() {
  return (
    <SettingSection title="Keep awake" help={HELP}>
      <Controls />
    </SettingSection>
  );
}
