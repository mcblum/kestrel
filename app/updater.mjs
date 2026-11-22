// Updates, with electron-updater's generic provider. Packaged app only: a checkout never checks.
//
// The feed is one file per platform at FEED_URL (KESTREL_UPDATE_FEED overrides it, for testing
// against a local server): `latest-mac.yml`, `latest.yml` for Windows, `latest-linux.yml` for the
// Linux AppImage. It names the file to download, by an absolute URL wherever that is hosted.
// update-support.mjs says which copies update at all, and why the others do not.
// Checks run shortly after launch and every few hours; a found update downloads in the background;
// when it is ready the page shows a quiet notice with a Restart button (ui UpdateNotice). Nothing
// restarts by itself: the user restarts, or the update is installed the next time Kestrel quits.
//
// A feed that is not there yet (404 until the first release is published) is silent on the
// automatic checks and a plain sentence on "Check for Updates…".
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { isMissingFeed, updateSupport } from './update-support.mjs';

export { isMissingFeed };

const { autoUpdater } = electronUpdater;

export const FEED_URL = 'https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/';
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** @typedef {{ status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error', version?: string, percent?: number }} UpdateState */

/** The feed's base URL: the env override for tests, else the release feed. Always ends in a slash. */
export function feedUrl(env = process.env) {
  const raw = env.KESTREL_UPDATE_FEED || FEED_URL;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

const logger = {
  info: (m) => console.log(`[update] ${m}`),
  warn: (m) => console.warn(`[update] ${m}`),
  error: (m) => console.error(`[update] ${String(m).split('\n')[0]}`),
  debug: () => {},
};

/**
 * Starts the updater. `send(state)` tells the page; `beforeRestart()` stops the server (and its
 * agents) before the app quits into the new version. Returns what the menu and IPC need.
 */
export function startUpdater({ send, beforeRestart, getWindow }) {
  /** @type {UpdateState} */
  let state = { status: 'idle' };
  const support = updateSupport({ platform: process.platform, packaged: app.isPackaged, env: process.env });
  const enabled = support.enabled;
  const set = (next) => {
    state = next;
    send(state);
  };

  if (enabled) {
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = true;
    // A downloaded update is also installed when Kestrel quits normally, so nobody has to restart for it.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    // Test aid: the installer reopens the app with no arguments, so a test copy run with its own
    // --user-data-dir would reopen on the real profile. KESTREL_UPDATE_NO_RELAUNCH=1 makes
    // Restart quit and install without reopening; the tester opens the new version.
    autoUpdater.autoRunAppAfterInstall = process.env.KESTREL_UPDATE_NO_RELAUNCH !== '1';
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() });
    autoUpdater.on('checking-for-update', () => state.status !== 'ready' && set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => state.status !== 'ready' && set({ status: 'idle' }));
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => state.status === 'downloading' && set({ ...state, percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (error) => {
      if (state.status === 'ready') return;
      set({ status: isMissingFeed(error) ? 'idle' : 'error' });
    });
    const check = () => {
      if (state.status === 'ready' || state.status === 'downloading') return;
      autoUpdater.checkForUpdates().catch((error) => logger.error(isMissingFeed(error) ? 'no update feed published yet' : error));
    };
    setTimeout(check, Number(process.env.KESTREL_UPDATE_FIRST_CHECK_MS) || FIRST_CHECK_DELAY_MS).unref?.();
    setInterval(check, CHECK_EVERY_MS).unref?.();
  }

  const tell = async (message, detail = '') => {
    const win = getWindow();
    const options = { type: 'info', message, detail, buttons: ['OK'] };
    await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  };

  return {
    state: () => state,
    /** "Check for Updates…" from the app menu: always says what happened. */
    async checkNow() {
      if (!support.enabled) return tell('Updates are off', support.reason);
      if (state.status === 'ready') return tell(`Kestrel ${state.version} is ready`, 'Restart Kestrel to update.');
      if (state.status === 'downloading') return tell(`Kestrel ${state.version} is downloading`, 'It will be ready in a moment.');
      try {
        const result = await autoUpdater.checkForUpdates();
        const newer = result?.isUpdateAvailable ?? (result?.updateInfo && result.updateInfo.version !== app.getVersion());
        if (!newer) return tell('You’re up to date', `Kestrel ${app.getVersion()} is the newest version.`);
        return tell(`Kestrel ${result.updateInfo.version} is available`, 'It is downloading now. Kestrel will offer a restart when it is ready.');
      } catch (error) {
        if (isMissingFeed(error)) return tell('No updates are published yet', `Kestrel ${app.getVersion()} is the newest version there is.`);
        return tell('Could not check for updates', String(error?.message ?? error).split('\n')[0]);
      }
    },
    /** The page's Restart button. Only once an update is downloaded. */
    async restart() {
      if (state.status !== 'ready') return false;
      await beforeRestart();
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}
