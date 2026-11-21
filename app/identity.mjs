// What the app calls itself: the name in the menu bar's app menu ("About Kestrel", "Quit
// Kestrel"), the About panel, and the Dock icon of an unpackaged app.
//
// The packaged app gets all of this from its bundle (electron-builder.yml: productName, icon,
// copyright). A checkout runs inside node_modules' Electron.app, whose Info.plist still says
// "Electron": the bold app name in the menu bar and the Dock label come from that file and
// stay "Electron" there. The name used for menus and the About panel, and the Dock icon, are set here.
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { devIconPath, isPackaged } from './paths.mjs';

export const APP_NAME = 'Kestrel';
export const COPYRIGHT = '© 2026 Matt Blum';

/** Call before `ready`. The name also picks the userData folder (~/Library/Application Support/Kestrel). */
export function setAppIdentity() {
  app.setName(APP_NAME);
  // Pages (and the browser pane's sites) see "Kestrel/<version> Chrome/…", not "Electron/…".
  app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '');
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), version: '', copyright: COPYRIGHT });
  if (!isPackaged && process.platform === 'darwin' && existsSync(devIconPath)) {
    void app.whenReady().then(() => app.dock?.setIcon(devIconPath));
  }
}
