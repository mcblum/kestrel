// Kestrel's Electron shell: one window, the platform's usual menu, and the server as a child process.
//
// What it does, in order: makes the per-launch token, starts the server for exactly this app's
// origin, opens the window with a preload script that hands the page the server address and
// token (replacing the Vite dev hand-off), and on quit stops the server and the agents it runs.
//
// Dev: KESTREL_UI_URL points at the Vite dev server (`pnpm dev:app` sets it).
// Otherwise the built UI is served from the app's own app://kestrel origin (paths.mjs says where
// it is: ui/dist in a checkout, inside the app archive when packaged).
import { vaultKey } from './vault-key.mjs';
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, net, protocol, session, shell, webContents } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setAppIdentity } from './identity.mjs';
import { createFolderChooser } from './folder-chooser.mjs';
import { buildMenu, cleanAccelerators } from './menu.mjs';
import { createFolderQueue, foldersInArgs, foldersOnly } from './open-folders.mjs';
import { isPackaged, preloadPath, uiDist } from './paths.mjs';
import { openServerLog } from './server-log.mjs';
import { freePort, startServer } from './server-process.mjs';
import { resolveShellEnv } from './shell-env.mjs';
import { startUpdater } from './updater.mjs';
import { loadBounds, trackBounds } from './window-state.mjs';

const devUrl = process.env.KESTREL_UI_URL || null;
const APP_ORIGIN = 'app://kestrel';
const origin = devUrl ? new URL(devUrl).origin : APP_ORIGIN;
/** For the built UI. No script-src: an agent's widget is a sandboxed srcdoc frame, which inherits
 *  this policy, and may load its own scripts (it does from a checkout, where Vite sets none). */
const BUILT_UI_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

setAppIdentity();
// A second copy with its own data (the demo, `pnpm demo`) keeps its own app state too, so it can
// run beside the first: the one-instance lock below goes by this folder.
if (process.env.KESTREL_APP_USER_DATA) app.setPath('userData', process.env.KESTREL_APP_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.KESTREL_APP_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.KESTREL_APP_DEBUG_PORT);
if (process.env.KESTREL_APP_THEME === 'light' || process.env.KESTREL_APP_THEME === 'dark') nativeTheme.themeSource = process.env.KESTREL_APP_THEME;

let server = null;
let win = null;
let quitting = false;
let updater = null;
const launch = { port: 0, token: randomBytes(32).toString('hex') };

// ---- the browser pane ----------------------------------------------------------------------
// A session's browser pane is a <webview> in the app window. Everything that keeps the page in it
// away from the app is enforced here, in the main process, whatever the UI asks for:
//   - it gets no preload, no Node, its own process (sandbox) and context isolation, so it never
//     sees `window.kestrelShell`, the server token, or anything else the app's preload exposes;
//   - it uses its own persistent session (cookies, storage), separate from the app's;
//   - it only ever loads http and https, and never Kestrel's own server or the app's own origin,
//     so a page (or an agent driving it) cannot reach the loopback API or load the UI with its token;
//   - it cannot open windows: a popup or target=_blank link loads in the same pane instead.
const BROWSER_PARTITION = 'persist:kestrel-browser'; // same name as server/src/shared/browser.ts
const SCREENSHOT_MAX_WIDTH = 1600;
/** Webviews attached to the app window, by their webContents id: the only ones the UI may capture. */
const browserGuests = new Set();

const isLoopbackHost = (hostname) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
};

const portOf = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));
/** The Vite dev server's port when the UI comes from this computer: it hands out the token under every name for it. */
const devUiPort = devUrl && isLoopbackHost(new URL(devUrl).hostname) ? portOf(new URL(devUrl)) : null;

/** Whether the browser pane may load this address. */
function browserUrlAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // The app's own origin: in development the Vite server hands the page the token. Under any name
  // for this computer too (localhost:5173 is the same server as 127.0.0.1:5173).
  if (url.origin === origin) return false;
  const port = portOf(url);
  if (isLoopbackHost(url.hostname) && devUiPort !== null && port === devUiPort) return false;
  return !(isLoopbackHost(url.hostname) && port === launch.port);
}

/** Requests from the browser pane's session (any resource, not only pages) to Kestrel itself are cancelled. */
function guardBrowserSession() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const asHttp = details.url.replace(/^ws/, 'http');
    callback({ cancel: !browserUrlAllowed(asHttp) });
  });
  // Failed loads of a page's parts (a script that 404s, a request refused here) are not console
  // messages, so the window is told, for the pane's console. A page that fails to load at all is
  // reported by the webview itself (did-fail-load).
  const failed = (details, text) => {
    if (!win || !browserGuests.has(details.webContentsId)) return;
    win.webContents.send('kestrel:browser-load-failed', { webContentsId: details.webContentsId, url: details.url.slice(0, 2000), text });
  };
  ses.webRequest.onCompleted((details) => details.statusCode >= 400 && failed(details, `${details.statusCode} ${details.statusLine.replace(/^HTTP\/\S+\s+\d+\s*/, '')}`.trim()));
  ses.webRequest.onErrorOccurred((details) => {
    if (details.resourceType === 'mainFrame' || details.error === 'net::ERR_ABORTED') return;
    failed(details, details.error === 'net::ERR_BLOCKED_BY_CLIENT' ? 'refused by Kestrel' : details.error);
  });
  // No camera, microphone, location, notifications, MIDI or the like for web pages in the pane.
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

/** Locks down each <webview> before it attaches, and steers its navigation after. */
function guardWebviews(host) {
  host.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.partition = BROWSER_PARTITION;
    params.partition = BROWSER_PARTITION;
    if (!browserUrlAllowed(params.src ?? '')) event.preventDefault();
  });
  host.on('did-attach-webview', (_event, guest) => {
    browserGuests.add(guest.id);
    guest.once('destroyed', () => browserGuests.delete(guest.id));
    // Popups and target=_blank load in the pane itself; never a new window.
    guest.setWindowOpenHandler(({ url }) => {
      if (browserUrlAllowed(url)) void guest.loadURL(url);
      return { action: 'deny' };
    });
    const refuse = (event, url) => !browserUrlAllowed(url) && event.preventDefault();
    guest.on('will-navigate', (event) => refuse(event, event.url));
    guest.on('will-redirect', (event) => refuse(event, event.url));
  });
}

/** A picture of the visible page in one of our webviews, at most SCREENSHOT_MAX_WIDTH wide, as base64 PNG. */
async function captureBrowser(id) {
  if (!browserGuests.has(id)) return null;
  const guest = webContents.fromId(id);
  if (!guest || guest.isDestroyed()) return null;
  let image = await guest.capturePage();
  if (image.isEmpty()) return null;
  if (image.getSize().width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: 'good' });
  const { width, height } = image.getSize();
  return { mediaType: 'image/png', data: image.toPNG().toString('base64'), width, height };
}

/** Bring the window to the front (restoring it if minimized). */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// One window, one instance: a second launch focuses the first (and hands it any folder it was
// given: see "folders opened with Kestrel" below).
if (!app.requestSingleInstanceLock()) app.quit();

// ---- folders opened with Kestrel -----------------------------------------------------------
// A folder dropped on the Dock icon (or `open -a Kestrel.app <folder>`) opens Create project with it
// in the folder list; nothing is created until the user does. macOS sends it as open-file, on a cold
// launch before `ready`, so this is registered now and the folders wait in a queue the page empties
// when it is ready (kestrel:take-open-folders); a running app is brought to the front and the page
// told there is something to take. Files are ignored. The Dock only accepts the drop because the
// packaged Info.plist declares folders (CFBundleDocumentTypes in electron-builder.config.cjs): under
// `pnpm dev:app` the Dock icon is the stock Electron.app, which does not, so this needs a packaged build.
const openedFolders = createFolderQueue();
app.on('open-file', (event, path) => {
  event.preventDefault();
  const folders = foldersOnly([path]);
  if (folders.length === 0) return;
  openedFolders.add(folders);
  if (!win) return; // before the window: the page takes them once it is ready
  showWindow();
  win.webContents.send('kestrel:open-folders');
});

/** Folders that arrived some other way than open-file: queued, and the page told when it is there. */
function takeFolders(folders) {
  if (folders.length === 0) return;
  openedFolders.add(folders);
  win?.webContents.send('kestrel:open-folders');
}
// Windows and Linux have no open-file: a folder dropped on Kestrel's shortcut, or "Open with", is
// an argument of the launch. This launch's own are queued now; a later launch's reach the running
// app here. A checkout's arguments are Electron's own, so only an installed app reads them.
if (isPackaged && process.platform !== 'darwin') takeFolders(foldersInArgs(process.argv, process.cwd()));
app.on('second-instance', (_event, argv, workingDirectory) => {
  showWindow();
  if (isPackaged && process.platform !== 'darwin') takeFolders(foldersInArgs(argv, workingDirectory));
});

function serveBuiltUi() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'kestrel') return new Response('Not found', { status: 404 });
    const wanted = normalize(join(uiDist, decodeURIComponent(url.pathname)));
    // Stay inside ui/dist whatever the path says; unknown paths get the app shell (hash routing).
    const file = wanted.startsWith(uiDist + sep) && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(uiDist, 'index.html');
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', BUILT_UI_CSP);
    return new Response(response.body, { status: response.status, headers });
  });
}

function sendCommand(command) {
  win?.webContents.send('kestrel:command', command);
}

function createWindow() {
  win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 900,
    minHeight: 600,
    title: 'Kestrel',
    // On the Mac the page runs to the top of the window: no title bar, the traffic lights sit
    // over the sidebar, and the tab strip is the drag area (see the `.mac-chrome` styles). Windows
    // and Linux keep the system's own title bar and the menu bar under it.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1d' : '#fafafa',
    // webviewTag: the session's browser pane. Its pages are locked down in guardWebviews.
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true },
  });
  trackBounds(win);
  // A browser's Back and Forward where they are not menu keys: Alt with the arrows on Windows and
  // Linux (on a Mac Option with an arrow moves the cursor by a word, and the keys are ⌘[ and ⌘]), and
  // the mouse's and keyboard's own back and forward buttons on Windows.
  if (process.platform !== 'darwin') {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.alt || input.control || input.meta || input.shift) return;
      const command = input.key === 'ArrowLeft' ? 'back' : input.key === 'ArrowRight' ? 'forward' : null;
      if (!command) return;
      event.preventDefault();
      sendCommand(command);
    });
    win.on('app-command', (_event, command) => {
      if (command === 'browser-backward') sendCommand('back');
      else if (command === 'browser-forward') sendCommand('forward');
    });
  }
  guardWebviews(win.webContents);
  // The page may only ever show the app. Links elsewhere open in the browser, never in this window.
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The page places the sidebar button beside the traffic lights, which full screen hides.
  const sendFullScreen = () => win?.webContents.send('kestrel:full-screen', win.isFullScreen());
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.webContents.on('did-finish-load', sendFullScreen);
  // The page holds settings the user changed and did not save (ui/src/unsaved.ts): it refuses to
  // unload, and the choice is theirs. Without this the window would simply not close.
  win.webContents.on('will-prevent-unload', (event) => {
    const leave = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0, message: 'You have settings changes that are not saved.', detail: 'If you leave now, those changes are lost.' }) === 1;
    if (leave) event.preventDefault();
  });
  win.on('closed', () => (win = null));
  void win.loadURL(devUrl ?? `${APP_ORIGIN}/`);
  if (process.env.KESTREL_APP_CAPTURE) win.webContents.once('did-finish-load', () => setTimeout(() => void capture(process.env.KESTREL_APP_CAPTURE), 3500));
}

/** Test aid: save a screenshot of the window to a file and quit. Only with KESTREL_APP_CAPTURE set. */
async function capture(path) {
  const { writeFileSync } = await import('node:fs');
  const image = await win.webContents.capturePage();
  writeFileSync(path, image.toPNG());
  app.quit();
}

/** The About panel says which channel this copy is on: "Version 0.0.32-beta.1 (beta channel)". */
function showChannelInAbout(channel) {
  app.setAboutPanelOptions({ applicationVersion: app.getVersion(), version: channel.beta ? 'beta channel' : 'stable channel' });
}

/** Stops the server (and the agents it runs) before quitting; the updater's restart uses it too. */
async function stopServer() {
  quitting = true;
  hideWindows();
  await server?.stop();
}

/**
 * Quitting takes the window away at once. The server is stopped behind it; left on screen, the page
 * loses its server first and says "Reconnecting…" at someone who has just asked to quit.
 */
function hideWindows() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.hide();
}

async function boot() {
  launch.port = await freePort();
  // An app opened from Finder has a minimal PATH; the server and everything it starts get the
  // user's login-shell environment instead (shell-env.mjs). A checkout already has it.
  const shellEnv = isPackaged ? await resolveShellEnv() : { env: process.env, source: 'inherited' };
  console.log(`[kestrel] environment: ${shellEnv.source}`);
  // An installed app has no terminal to print to: keep the server's output in the system's log
  // folder for Kestrel (server-log.mjs says where that is on each platform).
  const writeLog = isPackaged ? openServerLog(app.getPath('logs')) : undefined;
  writeLog?.(`[kestrel] environment: ${shellEnv.source}\n`);
  server = await startServer({ port: launch.port, token: launch.token, origin, dataDir: process.env.KESTREL_DATA_DIR, baseEnv: shellEnv.env, writeLog, vaultKey: vaultKey() });
  // If the server dies while the app is open there is nothing useful left to show.
  void server.exited.then((code) => {
    if (quitting) return;
    dialog.showErrorBox('Kestrel’s server stopped', `The server exited unexpectedly (code ${code}). Kestrel will quit.`);
    app.exit(1);
  });
  ipcMain.on('kestrel:launch', (event) => {
    // Only our own window gets the token.
    event.returnValue = win && event.sender === win.webContents ? launch : null;
  });
  ipcMain.on('kestrel:app-info', (event) => {
    event.returnValue = { name: app.getName(), version: app.getVersion(), packaged: isPackaged, updateChannel: updater?.channel() ?? null };
  });
  updater = startUpdater({ send: (state) => win?.webContents.send('kestrel:update', state), beforeRestart: stopServer, getWindow: () => win });
  showChannelInAbout(updater.channel());
  // Settings → General → Get beta versions (app/update-channel.mjs keeps it). Answers the channel
  // now, or { error } with the reason it could not be saved.
  ipcMain.handle('kestrel:set-beta-updates', (event, beta) => {
    if (!win || event.sender !== win.webContents) return { error: 'Only Kestrel’s own window can change this.' };
    try {
      const channel = updater.setBeta(beta === true);
      showChannelInAbout(channel);
      return channel;
    } catch (error) {
      return { error: `Could not save the choice: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  ipcMain.handle('kestrel:update-state', (event) => (win && event.sender === win.webContents ? updater.state() : null));
  ipcMain.handle('kestrel:update-restart', (event) => (win && event.sender === win.webContents ? updater.restart() : false));
  // Every folder chooser in the app comes through here; it reopens where the last pick was made.
  const pickFolder = createFolderChooser({
    file: join(app.getPath('userData'), 'folder-chooser.json'),
    showOpenDialog: (options) => dialog.showOpenDialog(win, options),
  });
  ipcMain.handle('kestrel:pick-folder', (event) => {
    if (!win || event.sender !== win.webContents) return null;
    return pickFolder({ title: 'Choose a folder' });
  });
  ipcMain.handle('kestrel:take-open-folders', (event) => (win && event.sender === win.webContents ? openedFolders.take() : []));
  ipcMain.handle('kestrel:capture-browser', (event, id) => {
    // Only our window, and only a webview attached to it.
    if (!win || event.sender !== win.webContents || !Number.isSafeInteger(id)) return null;
    return captureBrowser(id);
  });
  ipcMain.handle('kestrel:reveal', (event, path) => {
    // Only our window, and only a path that is a registered project's folder.
    if (!win || event.sender !== win.webContents || typeof path !== 'string') return;
    shell.showItemInFolder(path);
  });
  if (!devUrl) serveBuiltUi();
  guardBrowserSession();
  const menuOptions = { devTools: Boolean(devUrl) || process.env.KESTREL_APP_DEVTOOLS === '1', checkForUpdates: () => void updater.checkNow() };
  Menu.setApplicationMenu(buildMenu(sendCommand, menuOptions));
  // The user's own keys for Kestrel's commands: the menu is built again with them (ui/src/shortcuts.ts).
  ipcMain.on('kestrel:set-shortcuts', (event, accelerators) => {
    if (!win || event.sender !== win.webContents) return;
    Menu.setApplicationMenu(buildMenu(sendCommand, { ...menuOptions, accelerators: cleanAccelerators(accelerators) }));
  });
  // A system notification for the page (ui/src/notifier.ts). Shown from here, not with the page's
  // own Notification, so that a refusal by the system comes back as a reason instead of nothing:
  // macOS shows notifications only from a signed app the user has allowed. A click brings the
  // window forward and tells the page which session it was for.
  const shown = new Set();
  ipcMain.handle('kestrel:notify', (event, raw) => {
    if (!win || event.sender !== win.webContents) return { ok: false, reason: 'not the app window' };
    if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
    // What the click is for, handed back as it came: a session's id, or a review request's key behind a mark (shared/notifications.ts `targetOf`).
    const sessionId = text(raw?.sessionId, 400);
    return new Promise((resolve) => {
      const note = new Notification({ title: text(raw?.title, 200) || 'Kestrel', body: text(raw?.body, 400), silent: true });
      shown.add(note); // kept until it is over: a collected notification never tells of its click
      const done = (answer) => resolve(answer);
      const gone = () => shown.delete(note);
      note.on('show', () => done({ ok: true }));
      note.on('failed', (_event, error) => (gone(), done({ ok: false, reason: String(error) })));
      note.on('close', gone);
      note.on('click', () => {
        gone();
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (sessionId) win.webContents.send('kestrel:notification-click', sessionId);
      });
      note.show();
      // The system answers at once when it answers at all.
      setTimeout(() => done({ ok: false, reason: 'no answer' }), 5000);
    });
  });
  createWindow();
}

app.whenReady().then(() => boot().catch((error) => {
  dialog.showErrorBox('Kestrel could not start', String(error?.message ?? error));
  app.exit(1);
}));

app.on('window-all-closed', () => app.quit());
app.on('activate', () => !win && server && createWindow());

// Quit stops the server, which stops the agents and flushes the store, and waits for it.
app.on('before-quit', (event) => {
  if (quitting || !server) return;
  quitting = true;
  event.preventDefault();
  hideWindows();
  void server.stop().finally(() => app.exit(0));
});
