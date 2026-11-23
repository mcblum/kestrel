// Settings → Notifications (server: shared/notifications.ts, notifications/api.ts):
// one switch for all of it at the top, as macOS has; then which events; and how: a desktop notification, a
// sound, or both (Matt, 2026-11-21: the two ways must read as the two ways, not as a fifth event). Held once in the app
// store through useResource (the notifier reads the same entry); a change writes back what the
// server stored.
import { useState } from 'react';
import { NOTIFY_KIND_LABEL, NOTIFY_KINDS, silentReason, SOUND_LABEL, SOUNDS, type NotifyPrefs, type SoundId } from '@kestrel/server/notifications';
import { useResource } from '../data/resources.ts';
import { askForBanners, asNotifyPrefs, bannerPermission, NOTIFICATIONS_PATH, sendTestBanner, shellShowsBanners, useBannerProblem, type NotifyAnswer } from '../notifier.ts';
import { playSound } from '../sounds.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

/** The controls alone, as Settings → Notifications and setup's Notifications step (onboarding/NotificationStep.tsx) both draw them. */
export function NotificationControls() {
  const loaded = useResource(NOTIFICATIONS_PATH, asNotifyPrefs).value;
  // The desktop app shows banners itself and needs no permission from the page; a browser does.
  const shell = shellShowsBanners();
  const [permission, setPermission] = useState(() => (shell ? 'granted' : bannerPermission()));
  const problem = useBannerProblem();
  const [tested, setTested] = useState<string | null>(null);
  const test = async () => {
    setTested('Sending…');
    const result = await sendTestBanner();
    // A refusal's reason shows as the problem under the switch; here only what happened.
    setTested(result === 'shown' ? 'Sent. If you do not see it, check Focus and System Settings → Notifications → Kestrel.' : result === 'blocked' ? 'This browser has not allowed notifications yet.' : null);
  };
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const prefs = loaded.value;
  const save = async (next: NotifyPrefs) => {
    const answer = await act(() => call<NotifyAnswer>(NOTIFICATIONS_PATH, { method: 'PUT', body: JSON.stringify(next) }));
    if (answer) putResource(NOTIFICATIONS_PATH, asNotifyPrefs(answer));
  };
  const setBanner = async (banner: boolean) => {
    // A browser asks the first time; the answer decides whether a banner can show at all.
    if (banner && permission === 'default') setPermission(await askForBanners());
    await save({ ...prefs, banner });
  };
  const setSound = (sound: SoundId) => {
    playSound(sound); // hear what was picked
    void save({ ...prefs, sound });
  };
  const silent = silentReason(prefs);
  return (
    <>
      {/* As macOS has it: one switch for all of it, on top. Off, everything under it is dimmed and kept. */}
      <label className="tag-rule-switch notify-allow">
        <input type="checkbox" checked={prefs.enabled} onChange={(e) => void save({ ...prefs, enabled: e.target.checked })} />
        Allow notifications
      </label>
      <fieldset className="notify-events" disabled={!prefs.enabled}>
        <legend>Tell me when</legend>
        {NOTIFY_KINDS.map((kind) => (
          <label key={kind} className="tag-rule-switch">
            <input type="checkbox" checked={prefs.events[kind]} onChange={(e) => void save({ ...prefs, events: { ...prefs.events, [kind]: e.target.checked } })} />
            {NOTIFY_KIND_LABEL[kind]}
          </label>
        ))}
      </fieldset>
      {/* How: the two ways there are, a desktop notification and a sound. Either, both, or (said below) neither. */}
      <fieldset className="notify-how" disabled={!prefs.enabled}>
        <legend>Tell me with</legend>
        <label className="tag-rule-switch">
          <input type="checkbox" checked={prefs.banner} disabled={permission === 'unsupported'} onChange={(e) => void setBanner(e.target.checked)} />
          A desktop notification
        </label>
        {prefs.banner && problem && <p className="settings-help" role="alert">{problem}</p>}
        {prefs.banner && permission !== 'unsupported' && (
          <p className="settings-help notify-test">
            <button type="button" className="secondary-button" onClick={() => void test()}>Send a test notification</button>
            {tested && <span role="status">{tested}</span>}
          </p>
        )}
        {prefs.banner && permission === 'denied' && <p className="settings-help" role="alert">Notifications from Kestrel are blocked. Allow them in System Settings → Notifications (in a browser: in this site's settings), then they will show.</p>}
        {prefs.banner && permission === 'default' && (
          <p className="settings-help">
            This browser has not been asked to allow notifications yet. <button type="button" className="link-button" onClick={() => void askForBanners().then(setPermission)}>Allow notifications</button>
          </p>
        )}
        {permission === 'unsupported' && <p className="settings-help">This browser cannot show notifications; a sound still plays.</p>}
        <div className="notify-sound">
          <label htmlFor="notify-sound">A sound</label>
          <select id="notify-sound" className="form-control" value={prefs.sound} onChange={(e) => setSound(e.target.value as SoundId)}>
            {SOUNDS.map((sound) => <option key={sound} value={sound}>{SOUND_LABEL[sound]}</option>)}
          </select>
          <button type="button" className="secondary-button" disabled={prefs.sound === 'none'} onClick={() => playSound(prefs.sound)}>Play</button>
        </div>
      </fieldset>
      {silent && <p className="settings-help" role="status">{silent}</p>}
    </>
  );
}

const HELP = (
  <p className="settings-help">
    Kestrel tells you when a session you started finishes, when one fails, and when one stops to ask you something, so you can leave it in the background. You are not told about the session you are looking at, about a session you stopped yourself, or when a
    session another one delegated to finishes (that is news for the session that asked). A ticket newly assigned to you is told once, when tickets are on in Settings → Tickets and its source was already being checked; the tickets there when you first turn tickets or a source on are not. A click on a notification opens the session, the review request or the ticket. On a Mac the system asks once whether Kestrel may show notifications, the first time one is sent; after that it is a switch in System Settings → Notifications → Kestrel. "Send a test notification" shows one now, or says why it could not. The sound plays once per change, with or without the banner.
  </p>
);

export function NotificationsSetting({ page = false }: { page?: boolean } = {}) {
  return (
    <SettingSection level={page ? 1 : 2} className={page ? "settings-section settings-page-section" : "settings-section"} title="Notifications" help={HELP}>
      <NotificationControls />
    </SettingSection>
  );
}
