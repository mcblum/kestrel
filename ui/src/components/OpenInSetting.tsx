// Settings → General: the app "Open in" uses by default on the Changes and Files panes. Kestrel's
// own choice is VS Code when it is installed, else the first editor it finds, else Finder
// (@kestrel/server/file-menu, `defaultFolderApp`). Held once in the app store with the app list
// (folderApps.ts), so the button changes the moment this does.
import { SettingSection } from './SettingHelp.tsx';
import { thisComputer } from '../platform.ts';
import { defaultFolderApp, PREFERRED_FOLDER_APP } from '@kestrel/server/file-menu';
import { chooseDefaultFolderApp, useFolderApps } from './folderApps.ts';

const OWN_CHOICE = '';

function OpenInSettingControls() {
  const { apps, chosen } = useFolderApps();
  if (apps.length === 0) return <p className="settings-help">Kestrel found no app on this computer that can open a folder.</p>;
  const own = defaultFolderApp(apps, null);
  // Chosen once and uninstalled since: the button has gone back to Kestrel's choice, and so does this.
  const value = apps.some((a) => a.id === chosen) ? chosen! : OWN_CHOICE;
  return (
    <>
      <label className="settings-choice">
        Default app
        <select aria-label="Default app for Open in" value={value} onChange={(e) => void chooseDefaultFolderApp(e.target.value === OWN_CHOICE ? null : e.target.value)}>
          <option value={OWN_CHOICE}>Kestrel's choice{own ? ` (${own.label})` : ''}</option>
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function OpenInHelp() {
  const own = defaultFolderApp(useFolderApps().apps, null);
  return (
    <>
    <p className="settings-help">
      The app the Open in button on the Changes and Files panes opens a session's code in with one click. The arrow beside the button lists every app Kestrel found on {thisComputer()}. Left to Kestrel, it is{' '}
      {own?.id === PREFERRED_FOLDER_APP ? 'VS Code' : `VS Code when it is installed${own ? `; here, ${own.label}` : ''}`}.
    </p>
    </>
  );
}

export function OpenInSetting() {
  return (
    <SettingSection title="Open in" help={<OpenInHelp />}>
      <OpenInSettingControls />
    </SettingSection>
  );
}
