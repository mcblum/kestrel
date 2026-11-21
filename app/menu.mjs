// The app menu. Tab and session shortcuts send the same commands the page's own key handling
// would (see ui/src/commands.ts), so the menu and the page cannot disagree.
import { Menu, app } from 'electron';

/** Each command's key until the user changes it; the same defaults as server/src/shared/shortcuts.ts. */
const DEFAULT_ACCELERATORS = { 'new-session': 'CmdOrCtrl+N', 'new-tab': 'CmdOrCtrl+T', 'close-tab': 'CmdOrCtrl+W', switch: 'CmdOrCtrl+K', 'next-tab': 'CmdOrCtrl+Shift+]', 'prev-tab': 'CmdOrCtrl+Shift+[', 'toggle-sidebar': 'CmdOrCtrl+B' };

/** What the page may send as accelerators: known commands only, each a short string of key names. */
export function cleanAccelerators(value) {
  const out = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const id of Object.keys(DEFAULT_ACCELERATORS)) {
    const accelerator = value[id];
    if (typeof accelerator === 'string' && accelerator.length <= 60 && /^[A-Za-z0-9+\[\]`\-=,./;'\\]*$/.test(accelerator)) out[id] = accelerator;
  }
  return out;
}

/**
 * `checkForUpdates` runs "Check for Updates…" (updater.mjs). `accelerators`: the user's keys by
 * command id ('' for none), over the defaults (Settings → Keyboard shortcuts).
 */
export function buildMenu(send, { devTools, checkForUpdates, accelerators = {} }) {
  const cmd = (command) => () => send(command);
  /** A command's menu item with its key, or with none when the user took it away. */
  const item = (label, command) => {
    const accelerator = accelerators[command] ?? DEFAULT_ACCELERATORS[command];
    return { label, click: cmd(command), ...(accelerator ? { accelerator } : {}) };
  };
  const tabItems = Array.from({ length: 9 }, (_, i) => ({ label: `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, click: cmd(`tab:${i + 1}`) }));
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [{ role: 'about', label: `About ${app.name}` }, { label: 'Check for Updates…', click: checkForUpdates }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide', label: `Hide ${app.name}` }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: `Quit ${app.name}` }],
    },
    {
      label: 'File',
      submenu: [
        item('New Session', 'new-session'),
        item('New Session Tab', 'new-tab'),
        item('Close Tab', 'close-tab'),
        { type: 'separator' },
        item('Switch Session…', 'switch'),
        { type: 'separator' },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Tab',
      submenu: [item('Next Tab', 'next-tab'), item('Previous Tab', 'prev-tab'), { type: 'separator' }, ...tabItems],
    },
    {
      label: 'View',
      submenu: [item('Toggle Sidebar', 'toggle-sidebar'), { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, ...(devTools ? [{ role: 'toggleDevTools' }] : []), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ]);
}
