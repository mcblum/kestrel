// The app menu, built from menu-template.mjs (which says what is in it on each platform).
import { Menu, app } from 'electron';
import { cleanAccelerators, menuTemplate } from './menu-template.mjs';

export { cleanAccelerators };

/**
 * `checkForUpdates` runs "Check for Updates…" (updater.mjs). `accelerators`: the user's keys by
 * command id ('' for none), over the defaults (Settings → Keyboard shortcuts).
 */
export function buildMenu(send, options) {
  return Menu.buildFromTemplate(menuTemplate(send, { ...options, appName: app.name }));
}
