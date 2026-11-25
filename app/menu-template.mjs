// The app menu. On a Mac the first menu is the app's own (About, Check for Updates, Services,
// Hide, Quit). Windows and Linux have no such menu: Quit goes in File and About and Check for
// Updates in Help, where those platforms keep them. Tab and session shortcuts send the same commands the page's own key handling
// would (see ui/src/commands.ts), so the menu and the page cannot disagree. No Electron import here,
// so the template is tested; menu.mjs builds the menu from it.

/** Each command's key until the user changes it; the same defaults as server/src/shared/shortcuts.ts. */
const DEFAULT_ACCELERATORS = { 'new-session': 'CmdOrCtrl+N', 'new-tab': 'CmdOrCtrl+T', 'close-tab': 'CmdOrCtrl+W', switch: 'CmdOrCtrl+K', 'next-tab': 'CmdOrCtrl+Shift+]', 'prev-tab': 'CmdOrCtrl+Shift+[', 'toggle-sidebar': 'CmdOrCtrl+B', back: 'CmdOrCtrl+[', forward: 'CmdOrCtrl+]' };

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
export function menuTemplate(send, { devTools, checkForUpdates, accelerators = {}, platform = process.platform, appName = 'Kestrel' }) {
  const cmd = (command) => () => send(command);
  /** A command's menu item with its key, or with none when the user took it away. */
  const item = (label, command) => {
    const accelerator = accelerators[command] ?? DEFAULT_ACCELERATORS[command];
    return { label, click: cmd(command), ...(accelerator ? { accelerator } : {}) };
  };
  const tabItems = Array.from({ length: 9 }, (_, i) => ({ label: `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, click: cmd(`tab:${i + 1}`) }));
  const mac = platform === 'darwin';
  const update = { label: 'Check for Updates…', click: checkForUpdates };
  const appMenu = {
    label: appName,
    submenu: [{ role: 'about', label: `About ${appName}` }, update, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide', label: `Hide ${appName}` }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: `Quit ${appName}` }],
  };
  // What's New opens the release notes page (ui WhatsNewPage) as the page's own command would.
  const whatsNew = { label: 'What’s New', click: cmd('whats-new') };
  // A Mac keeps About and Check for Updates in the app menu; its Help menu has What's New alone.
  const helpMenu = { role: 'help', label: 'Help', submenu: mac ? [whatsNew] : [whatsNew, { type: 'separator' }, update, { type: 'separator' }, { role: 'about', label: `About ${appName}` }] };
  return [
    ...(mac ? [appMenu] : []),
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
        ...(mac ? [] : [{ type: 'separator' }, { role: 'quit', label: `Quit ${appName}` }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Tab',
      submenu: [item('Next Tab', 'next-tab'), item('Previous Tab', 'prev-tab'), { type: 'separator' }, ...tabItems],
    },
    {
      label: 'View',
      submenu: [item('Toggle Sidebar', 'toggle-sidebar'), { type: 'separator' }, item('Back', 'back'), item('Forward', 'forward'), { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, ...(devTools ? [{ role: 'toggleDevTools' }] : []), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    helpMenu,
  ];
}
