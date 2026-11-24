// Runs before the page, with access to Electron. It exposes exactly these to the page: the
// per-launch server address and token, the app's name and version, the updater's state and its restart, a native folder picker, folders opened with Kestrel from the Dock, where a dropped or chosen file is on disk, showing a folder in Finder, the
// app-menu commands, whether the window is full screen, a picture of the browser pane's page and its failed loads. It is never given to the browser
// pane's own pages (main.mjs strips every preload from webviews).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kestrelShell', {
  launch: ipcRenderer.sendSync('kestrel:launch'),
  /** {name, version, packaged, updateChannel: {beta, build}}: the version and channel are shown in Settings. */
  app: ipcRenderer.sendSync('kestrel:app-info'),
  /** Settings → General → Get beta versions: resolves the channel now, or {error} with the reason. */
  setBetaUpdates: (beta) => ipcRenderer.invoke('kestrel:set-beta-updates', beta === true),
  /** The updater's state now: {status: 'idle'|'checking'|'downloading'|'ready'|'error', version?, percent?}. */
  updateState: () => ipcRenderer.invoke('kestrel:update-state'),
  /** Every change of that state. */
  onUpdate(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('kestrel:update', handler);
    return () => ipcRenderer.removeListener('kestrel:update', handler);
  },
  /** Quit and reopen into the downloaded update (the server and its agents are stopped first). */
  restartToUpdate: () => ipcRenderer.invoke('kestrel:update-restart'),
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('kestrel:pick-folder'),
  /** Where a File the page got from a drop or the file chooser is on disk ('' when it has no path, e.g. pasted). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  reveal: (path) => ipcRenderer.invoke('kestrel:reveal', path),
  /** A PNG (base64) of the visible page in the browser pane's webview, by its webContents id. */
  captureBrowser: (webContentsId) => ipcRenderer.invoke('kestrel:capture-browser', webContentsId),
  /** A part of a browser-pane page that failed to load: {webContentsId, url, text}. For the pane's console. */
  onBrowserLoadFailed(listener) {
    const handler = (_event, failure) => listener(failure);
    ipcRenderer.on('kestrel:browser-load-failed', handler);
    return () => ipcRenderer.removeListener('kestrel:browser-load-failed', handler);
  },
  /** Whether the window is full screen: sent once the page has loaded and on every change. */
  onFullScreen(listener) {
    const handler = (_event, fullScreen) => listener(fullScreen === true);
    ipcRenderer.on('kestrel:full-screen', handler);
    return () => ipcRenderer.removeListener('kestrel:full-screen', handler);
  },
  /**
   * Folders opened with Kestrel (dropped on its Dock icon): the listener gets each batch, starting
   * with any that arrived before the page asked (a cold launch with a folder).
   */
  onOpenFolders(listener) {
    const take = () =>
      void ipcRenderer.invoke('kestrel:take-open-folders').then((paths) => Array.isArray(paths) && paths.length > 0 && listener(paths));
    ipcRenderer.on('kestrel:open-folders', take);
    take();
    return () => ipcRenderer.removeListener('kestrel:open-folders', take);
  },
  /** The keys the app menu gives Kestrel's commands: {commandId: accelerator}, '' for none (ui/src/shortcuts.ts). */
  setShortcuts: (accelerators) => ipcRenderer.send('kestrel:set-shortcuts', accelerators),
  /** Show a system notification: {title, body, sessionId}. Resolves {ok: true}, or {ok: false, reason} when the system refused it. */
  notify: (notification) => ipcRenderer.invoke('kestrel:notify', notification),
  /** A notification was clicked: the listener gets the id of the session it was for. */
  onNotificationClick(listener) {
    const handler = (_event, sessionId) => listener(sessionId);
    ipcRenderer.on('kestrel:notification-click', handler);
    return () => ipcRenderer.removeListener('kestrel:notification-click', handler);
  },
  onCommand(listener) {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on('kestrel:command', handler);
    return () => ipcRenderer.removeListener('kestrel:command', handler);
  },
});
