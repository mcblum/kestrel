// Setup's Notifications step: the same controls as Settings → Notifications (one copy, saved as
// they are changed), and what allowing them takes here. The desktop app cannot ask macOS ahead of
// time: the system asks once, when the first notification is sent, so sending a test is the ask.
// A browser asks when its own permission is requested, which the controls do.
import { Bell } from 'lucide-react';
import { platform, systemName } from '../platform.ts';
import { NotificationControls } from '../components/NotificationsSetting.tsx';
import { shellShowsBanners } from '../notifier.ts';

/** What allowing notifications takes in this window, in words. */
export const permissionNote = (shell: boolean, packaged: boolean): string =>
  !shell
    ? 'Your browser asks once whether Kestrel may show notifications. Allow them here, or later in Settings → Notifications.'
    : platform() !== 'mac'
      ? `${systemName()} shows Kestrel's notifications unless you have turned them off for it. Send a test notification now to see one.`
      : packaged
      ? 'macOS asks once whether Kestrel may show notifications, the first time one is sent. Send a test notification now to answer it here, not in the middle of your work.'
      : 'This copy of Kestrel is run from a checkout, which macOS does not let show notifications. The installed app can; a sound still plays here.';

export function NotificationStep() {
  const shell = shellShowsBanners();
  return <div className="setup-notify">
    <div className="setup-ready-row"><span className="setup-icon"><Bell aria-hidden /></span><div><h2>Allow notifications</h2><p>{permissionNote(shell, window.kestrelShell?.app?.packaged === true)}</p></div></div>
    <div className="setup-notify-controls"><NotificationControls /></div>
    <p className="form-note">Everything here can be changed later in Settings → Notifications.</p>
  </div>;
}
