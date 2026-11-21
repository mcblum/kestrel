// Settings → Git → New sessions: "Start new sessions from the latest base branch" (server:
// base-refresh.ts, git-settings/prefs.ts). On by default. Held once in the app store with the rest of
// the Git settings; a change writes back what the server stored.
import { SettingHeading } from './SettingHelp.tsx';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { GIT_SETTINGS_PATH, saveStartFromLatest, type GitSettingsView } from '../gitSettingsApi.ts';
import { useResource } from '../data/resources.ts';
import { act, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

const asView = (raw: unknown): Sourced<GitSettingsView> => ready(raw as GitSettingsView);

const HELP = (
  <p className="settings-help">
    Before making a new session's worktree, Kestrel fetches the branch your project's checkout is on (usually main) from its remote, and starts the session from the newest commit when your local branch is simply behind. Your own checkout is
    never changed, and a local branch with commits of its own is used as it is. If the remote cannot be reached within a few seconds, the session starts from your local branch and says so.
  </p>
);

export function StartFromLatestSetting() {
  const loaded = useResource(GIT_SETTINGS_PATH, asView).value;
  const change = async (startFromLatest: boolean) => {
    const view = await act(() => saveStartFromLatest(startFromLatest));
    if (view) putResource(GIT_SETTINGS_PATH, ready(view));
  };
  return (
    <section className="settings-section">
      <SettingHeading title="New sessions" help={HELP} />
      {loaded.state !== 'ready' ? (
        <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>
      ) : (
        <>
          <label className="tag-rule-switch">
            {/* A server from before this setting sends nothing for it: it behaved as off. */}
            <input type="checkbox" checked={loaded.value.startFromLatest === true} onChange={(e) => void change(e.target.checked)} />
            Start new sessions from the latest base branch
          </label>
        </>
      )}
    </section>
  );
}
