// Settings → General → Updates: the version this copy is, which channel it is on, and the "Get
// beta versions" switch. The choice is the Electron shell's, not the server's: the updater runs in
// the shell and must know it before the server starts (app/update-channel.mjs keeps it). It is held
// once, in the store's `updateChannel` slice, filled from the shell at load and replaced by what
// the shell answers when the switch is changed. In a plain browser there is no shell: only the
// section's absence says so.
import { actions, setApp, useApp, type UpdateChannel } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

/** "0.0.32-beta.1 (beta)": the version with its beta mark. */
export function versionText(version: string, channel: UpdateChannel | null): string {
  return channel?.build === 'beta' ? `${version} (beta)` : version;
}

/** Which channel the copy is on, in words. */
export function channelText(channel: UpdateChannel): string {
  return channel.beta ? 'On the beta channel: it updates to betas, and to each release newer than them.' : 'On the stable channel: it updates to releases only.';
}

async function change(beta: boolean) {
  const answer = await window.kestrelShell?.setBetaUpdates?.(beta);
  if (!answer) return actions.showError('This copy of Kestrel cannot change its update channel: update it first.');
  if ('error' in answer) return actions.showError(answer.error);
  setApp({ updateChannel: answer });
}

const HELP = (
  <p className="settings-help">
    Kestrel checks for updates shortly after it opens and every half hour, and offers a restart when one is ready. Turning betas off never goes back to an older version: the beta you have stays until a release newer than it comes out. Check
    for updates now from the Kestrel menu.
  </p>
);

export function UpdateChannelSetting() {
  const channel = useApp((s) => s.updateChannel);
  const app = window.kestrelShell?.app;
  if (!app) return null;
  return (
    <SettingSection title="Updates" help={HELP}>
      <p className="settings-version">
        Kestrel {versionText(app.version, channel)}
        {app.packaged ? '' : ' (run from a checkout, which does not update itself)'}.{channel ? ` ${channelText(channel)}` : ''}
      </p>
      {channel && (
        <>
          <label className="tag-rule-switch">
            <input type="checkbox" checked={channel.beta} onChange={(e) => void change(e.target.checked)} />
            Get beta versions
          </label>
          <p className="settings-help">Betas are earlier, less tested builds of the next version.</p>
        </>
      )}
    </SettingSection>
  );
}
