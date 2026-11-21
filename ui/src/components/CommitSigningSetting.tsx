// Settings → Permissions: "Commit signing" (server: shared/commit-signing.ts, commit-signing/). On by
// default. Held once in the app store through useResource, like "Keep each project's edits in its
// own session"; a change writes back what the server stored.
import { SettingSection } from './SettingHelp.tsx';
import type { CommitSigningPrefs } from '@kestrel/server/commit-signing';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

export const COMMIT_SIGNING_PATH = '/api/commit-signing';
const asPrefs = (raw: unknown): Sourced<CommitSigningPrefs> => ready(raw as CommitSigningPrefs);

function CommitSigningSettingControls() {
  const loaded = useResource(COMMIT_SIGNING_PATH, asPrefs).value;
  const change = async (allowed: boolean) => {
    const prefs = await act(() => call<CommitSigningPrefs>(COMMIT_SIGNING_PATH, { method: 'PATCH', body: JSON.stringify({ allowed }) }));
    if (prefs) putResource(COMMIT_SIGNING_PATH, ready(prefs));
  };
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={loaded.value.allowed} onChange={(e) => void change(e.target.checked)} />
        Let signed commits through a session's sandbox
      </label>
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      A session another session started runs its commands in a sandbox. When its repository signs commits, that sandbox may read your GnuPG folder and reach gpg-agent (or, for SSH signing, the SSH agent), so a signed commit needs no approval. Nothing there
      becomes writable, and your passphrase is still asked for by the agent itself. A command in the sandbox could ask the agent to sign other things too; turn this off to have every signed commit ask first.
    </p>
  </>
);

export function CommitSigningSetting() {
  return (
    <SettingSection title="Commit signing" help={HELP}>
      <CommitSigningSettingControls />
    </SettingSection>
  );
}
