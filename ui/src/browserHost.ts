// One scope's <webview>, made and driven by hand rather than rendered by React: its `src` is set
// once, when the first address is opened, and after that it is only driven with loadURL (a new
// `src` would reload the page). It is the pane's driver for the agent's calls too (browserOps.ts).
// The page is locked down by the Electron shell (app/main.mjs, will-attach-webview), whatever
// this file asks for.
import { BROWSER_PARTITION, consoleLevel, NAVIGATE_WAIT_MS, type NavigateResult, type PageInfo } from '@kestrel/server/browser';
import { refStoreKey } from '@kestrel/server/browser-scripts';
import type { PaneDriver, WebviewElement } from './browserOps.ts';
import { browserPane } from './browserStore.ts';

/** How long a click waits for the load it may have started to begin, and then to finish. */
const SETTLE_START_MS = 500;
const SETTLE_LOAD_MS = 10_000;
/** How many frames a picture waits for the pane to come on screen. */
const PAINT_FRAMES = 60;
/** Chromium's "aborted": a load replaced by another, not a failure. */
const ERR_ABORTED = -3;
const ELECTRON_WARNING = 'Electron Security Warning';

type FailEvent = Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
type ConsoleEvent = Event & { level: unknown; message: string; line: number; sourceId: string };
type NavigateEvent = Event & { url: string; isMainFrame?: boolean };
type TitleEvent = Event & { title: string };

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export class WebviewHost implements PaneDriver {
  readonly refKey = refStoreKey();
  private view: WebviewElement | null = null;
  /** dom-ready has fired: the webview's methods work. */
  private ready = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    readonly key: string,
    private readonly container: HTMLElement,
    /** Whether the pane is on screen now (or shown behind the app for a picture). */
    private readonly onScreen: () => Promise<boolean> | boolean,
    /** Told when the <webview> is made, so the window can keep its count of live pages. */
    private readonly onCreate: () => void = () => undefined,
  ) {}

  /** A <webview> exists: a page is alive in it. */
  get live(): boolean {
    return this.view !== null;
  }

  page(): WebviewElement | null {
    return this.ready ? this.view : null;
  }

  info(): PageInfo {
    const known = browserPane.view(this.key);
    if (!this.ready || !this.view) return { url: known.url, title: known.title };
    try {
      return { url: this.view.getURL(), title: this.view.getTitle() };
    } catch {
      return { url: known.url, title: known.title };
    }
  }

  console() {
    return browserPane.console(this.key);
  }

  async open(url: string): Promise<NavigateResult> {
    browserPane.setView(this.key, { url, note: null });
    const existing = this.view;
    const view = existing ?? this.create(url);
    // A navigation that replaces one still loading fires no new did-start-loading: count it as started.
    // A webview not yet at dom-ready is always still on its first load.
    const loading = existing ? !this.ready || this.isLoading(existing) : false;
    const loaded = this.waitForLoad(view, NAVIGATE_WAIT_MS, loading);
    if (existing && this.ready) existing.loadURL(url).catch(() => undefined); // the wait reports failures
    else if (existing) existing.setAttribute('src', url); // not ready for loadURL yet
    const { timedOut, failed } = await loaded;
    if (failed) throw new Error(`Could not open ${url}: ${failed}`);
    return { ...this.info(), timedOut };
  }

  async settle(): Promise<void> {
    const view = this.page();
    if (!view) return;
    const loading = this.isLoading(view) || (await this.waitFor(view, 'did-start-loading', SETTLE_START_MS));
    if (loading) await this.waitForLoad(view, SETTLE_LOAD_MS, true);
  }

  async painted(): Promise<void> {
    for (let i = 0; i < PAINT_FRAMES && !(await this.onScreen()); i++) await frame();
    await frame();
    await frame();
  }

  // ---- the user's controls --------------------------------------------------------------------

  back = () => this.page()?.goBack();
  forward = () => this.page()?.goForward();
  reloadOrStop = () => {
    const view = this.page();
    if (view) view.isLoading() ? view.stop() : view.reload();
  };

  destroy(): void {
    for (const off of this.cleanup.splice(0)) off();
    this.view?.remove();
    this.view = null;
    this.ready = false;
  }

  // ---- the webview ----------------------------------------------------------------------------

  private create(url: string): WebviewElement {
    const view = document.createElement('webview') as WebviewElement;
    // The browser's own cookies and storage. The shell forces this too.
    view.setAttribute('partition', BROWSER_PARTITION);
    // Lets the page ask for popups at all, so the shell can load them here instead (it never opens a window).
    view.setAttribute('allowpopups', 'true');
    view.setAttribute('src', url);
    view.className = 'browser-webview';
    this.view = view;
    this.listen(view);
    this.container.appendChild(view);
    this.onCreate();
    return view;
  }

  private on<E extends Event>(view: WebviewElement, type: string, handler: (event: E) => void): void {
    const listener = handler as EventListener;
    view.addEventListener(type, listener);
    this.cleanup.push(() => view.removeEventListener(type, listener));
  }

  private listen(view: WebviewElement): void {
    const id = this.key;
    this.on(view, 'dom-ready', () => {
      this.ready = true;
      this.sync();
    });
    this.on(view, 'did-start-loading', () => browserPane.setView(id, { loading: true }));
    this.on(view, 'did-stop-loading', () => this.sync());
    this.on<NavigateEvent>(view, 'did-navigate', (e) => {
      browserPane.log(id, { level: 'info', text: `Navigated to ${e.url}`, source: 'Kestrel', at: Date.now() });
      this.sync();
    });
    this.on<NavigateEvent>(view, 'did-navigate-in-page', (e) => e.isMainFrame !== false && this.sync());
    this.on<TitleEvent>(view, 'page-title-updated', (e) => browserPane.setView(id, { title: e.title }));
    this.on<ConsoleEvent>(view, 'console-message', (e) => {
      // Electron's own advice to app developers, printed into every page of an unpackaged build: not the page's.
      if (String(e.message).startsWith(ELECTRON_WARNING)) return;
      browserPane.log(id, { level: consoleLevel(e.level), text: String(e.message).slice(0, 2000), source: e.sourceId ? `${e.sourceId}:${e.line}` : undefined, at: Date.now() });
    });
    // A part of the page that failed to load (a 404 script, a request Kestrel refused): not a console message, so the shell says.
    const off = window.kestrelShell?.onBrowserLoadFailed?.((f) => {
      if (f.webContentsId === this.guestId()) browserPane.log(id, { level: 'error', text: `Failed to load ${f.url}: ${f.text}`, source: 'network', at: Date.now() });
    });
    if (off) this.cleanup.push(off);
    this.on<FailEvent>(view, 'did-fail-load', (e) => {
      if (e.errorCode === ERR_ABORTED) return;
      const reason = `${e.errorDescription || 'error'} (${e.errorCode})`;
      browserPane.log(id, { level: 'error', text: `Failed to load ${e.validatedURL}: ${reason}`, source: 'network', at: Date.now() });
      if (e.isMainFrame) browserPane.setView(id, { note: `Could not open ${e.validatedURL}: ${reason}`, loading: false });
    });
    this.on(view, 'render-process-gone', () => browserPane.setView(id, { note: 'The page stopped working. Reload to try again.', loading: false }));
  }

  /** Copy where the page is into the store, for the bar. */
  private sync(): void {
    const view = this.page();
    if (!view) return;
    try {
      browserPane.setView(this.key, { url: view.getURL(), title: view.getTitle(), loading: view.isLoading(), canGoBack: view.canGoBack(), canGoForward: view.canGoForward() });
    } catch {
      // The webview went away between the event and now.
    }
  }

  private guestId(): number | null {
    try {
      return this.view?.getWebContentsId() ?? null;
    } catch {
      return null;
    }
  }

  private isLoading(view: WebviewElement): boolean {
    try {
      return view.isLoading();
    } catch {
      return false;
    }
  }

  /** Whether `type` fires within `ms`. */
  private waitFor(view: WebviewElement, type: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (fired: boolean) => {
        clearTimeout(timer);
        view.removeEventListener(type, onEvent);
        resolve(fired);
      };
      const onEvent = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      view.addEventListener(type, onEvent);
    });
  }

  /** Wait for the main frame to finish loading (or fail), at most `ms`. */
  private waitForLoad(view: WebviewElement, ms: number, alreadyStarted: boolean): Promise<{ timedOut: boolean; failed: string | null }> {
    return new Promise((resolve) => {
      let started = alreadyStarted;
      const onStart = () => (started = true);
      const onStop = () => started && finish(false, null);
      const onFail = (event: Event) => {
        const e = event as FailEvent;
        if (e.isMainFrame && e.errorCode !== ERR_ABORTED) finish(false, `${e.errorDescription || 'error'} (${e.errorCode})`);
      };
      const timer = setTimeout(() => finish(true, null), ms);
      const finish = (timedOut: boolean, failed: string | null) => {
        clearTimeout(timer);
        view.removeEventListener('did-start-loading', onStart);
        view.removeEventListener('did-stop-loading', onStop);
        view.removeEventListener('did-fail-load', onFail);
        resolve({ timedOut, failed });
      };
      view.addEventListener('did-start-loading', onStart);
      view.addEventListener('did-stop-loading', onStop);
      view.addEventListener('did-fail-load', onFail);
    });
  }
}
