// The browser outside React, per scope, for the life of the window: where each scope's page is
// (address, title, loading), its console, and a session agent's calls. The server sends a call to
// the window that shows the session (`browser-serve`), or else to any desktop window
// (`browser-serve-any`): every page lives in the window's browser layer (browserLayer.ts), so a
// call runs whether or not the session is in front. When it is, a call that opens a page or takes
// its picture brings the Browser pane up so the user sees it. Message shapes are in
// @kestrel/server/browser.
import { useSyncExternalStore } from 'react';
import { appendConsole, isBrowserOp, NEEDS_DESKTOP, NO_PAGE, NO_WINDOW, type BrowserGuard, type ConsoleEntry } from '@kestrel/server/browser';
import type { WebviewHost } from './browserHost.ts';
import { performOp } from './browserOps.ts';
import { browserSocket, serverPort, type SocketMessage } from './store.ts';

/** Only the desktop app has <webview>. In a plain browser the pane says so and calls are refused. */
export const hasBrowserPane = Boolean(window.kestrelShell);

export interface BrowserView {
  /** The address shown, and the one the pane comes back to after it was closed. */
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Why the last address was not opened, until the next one is. */
  note: string | null;
}

const EMPTY: BrowserView = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, note: null };

/**
 * Each session's last address, kept for the life of the window: sessionStorage survives reloading
 * the window (⌘R) and is gone when it closes. Storage that throws just means nothing is remembered.
 */
const URL_KEY = 'kestrel.browser.url.';
function rememberedViews(): Map<string, BrowserView> {
  const found = new Map<string, BrowserView>();
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      const url = key?.startsWith(URL_KEY) ? sessionStorage.getItem(key) : null;
      if (key && url) found.set(key.slice(URL_KEY.length), { ...EMPTY, url });
    }
  } catch {
    // no storage: start empty
  }
  return found;
}
function rememberUrl(key: string, url: string): void {
  try {
    if (url) sessionStorage.setItem(URL_KEY + key, url);
    else sessionStorage.removeItem(URL_KEY + key);
  } catch {
    // not remembered across a reload; the pane still works
  }
}

let views: ReadonlyMap<string, BrowserView> = rememberedViews();
const consoles = new Map<string, readonly ConsoleEntry[]>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** A session's pane state; re-renders only when that session's entry changes. */
export function useBrowserView(sessionId: string): BrowserView {
  return useSyncExternalStore(subscribe, () => views.get(sessionId) ?? EMPTY);
}

/** Only the page title, so the toolbar re-renders when the title changes and not on every load. */
export function useBrowserTitle(sessionId: string): string {
  return useSyncExternalStore(subscribe, () => views.get(sessionId)?.title ?? '');
}

/** What the pane may not open: Kestrel's own server, and the origin this UI is served from. */
export const browserGuard = (): BrowserGuard => ({ serverPort: serverPort(), appOrigins: [window.location.origin] });

// ---- who answers --------------------------------------------------------------------------------

/** A session's workspace on screen; `reveal` opens its Browser view. Several can show one session (the newest answers). */
interface Shown {
  reveal(): void;
}
const shown = new Map<string, readonly Shown[]>();

/** The window's browser layer (browserLayer.ts), which runs a call in a scope's page. */
export interface PageLayer {
  using<T>(key: string, work: (host: WebviewHost) => Promise<T>): Promise<T>;
}
let layer: PageLayer | null = null;

const say = (sessionId: string) => browserSocket.send(shown.get(sessionId)?.length ? { type: 'browser-serve', sessionId, capable: hasBrowserPane } : { type: 'browser-unserve', sessionId });
/** This window takes calls for any session: a desktop window can run them in the background. */
const sayAny = () => browserSocket.send({ type: 'browser-serve-any', capable: hasBrowserPane && layer !== null });

async function run(m: SocketMessage): Promise<object> {
  const { sessionId, op } = m;
  const args = typeof m.args === 'object' && m.args !== null ? (m.args as Record<string, unknown>) : {};
  if (!isBrowserOp(op)) throw new Error('Kestrel does not know that browser call.');
  if (!hasBrowserPane) throw new Error(NEEDS_DESKTOP);
  if (!layer) throw new Error(NO_WINDOW);
  // The user watches what the agent does: opening a page or taking its picture brings the pane up
  // when the session is on screen. Otherwise the call runs in the background.
  if (op === 'navigate' || op === 'screenshot') shown.get(sessionId)?.at(-1)?.reveal();
  return layer.using(sessionId, async (host) => {
    if (!host.live && op !== 'navigate') {
      const last = views.get(sessionId)?.url ?? '';
      if (op === 'console') return { url: last, title: '', entries: consoles.get(sessionId) ?? [] };
      if (!last) throw new Error(NO_PAGE);
      await host.open(last); // closed to save memory: it comes back where it was
    }
    return performOp(host, op, args, browserGuard());
  });
}

function receive(m: SocketMessage): void {
  if (m.type !== 'browser-request' || typeof m.requestId !== 'string') return;
  const answer = (body: object) => browserSocket.send({ type: 'browser-response', requestId: m.requestId, sessionId: m.sessionId, ...body });
  run(m).then(
    (result) => answer({ ok: true, result }),
    (error: unknown) => answer({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
}

browserSocket.register({
  message: receive,
  opened: () => {
    sayAny();
    [...shown.keys()].forEach(say);
  },
});

// ---- the API the components use -----------------------------------------------------------------

export const browserPane = {
  /** A session's workspace is on screen. Returns the function to call when it leaves. */
  serve(sessionId: string, workspace: Shown): () => void {
    shown.set(sessionId, [...(shown.get(sessionId) ?? []), workspace]);
    say(sessionId);
    return () => {
      const rest = (shown.get(sessionId) ?? []).filter((w) => w !== workspace);
      if (rest.length) shown.set(sessionId, rest);
      else shown.delete(sessionId);
      say(sessionId);
    };
  },

  /** The window's browser layer is up: calls for any session can run here. */
  setLayer(next: PageLayer | null): void {
    layer = next;
    sayAny();
  },

  /**
   * Open `url` in the scope's page for the user (a saved action's preview), bringing the pane up
   * when the scope is on screen. False when this window has no browser pane (a plain browser).
   */
  async open(sessionId: string, url: string): Promise<boolean> {
    if (!hasBrowserPane || !layer) return false;
    shown.get(sessionId)?.at(-1)?.reveal();
    await layer.using(sessionId, (host) => performOp(host, 'navigate', { url }, browserGuard()));
    return true;
  },

  view: (sessionId: string): BrowserView => views.get(sessionId) ?? EMPTY,

  setView(sessionId: string, patch: Partial<BrowserView>): void {
    const prev = views.get(sessionId) ?? EMPTY;
    if ((Object.keys(patch) as (keyof BrowserView)[]).every((k) => prev[k] === patch[k])) return;
    views = new Map(views).set(sessionId, { ...prev, ...patch });
    if (patch.url !== undefined && patch.url !== prev.url) rememberUrl(sessionId, patch.url);
    for (const listener of listeners) listener();
  },

  log(sessionId: string, entry: ConsoleEntry): void {
    consoles.set(sessionId, appendConsole(consoles.get(sessionId) ?? [], entry));
  },

  console: (sessionId: string): readonly ConsoleEntry[] => consoles.get(sessionId) ?? [],

  /** A deleted scope's page: nothing of it is kept. */
  forget(key: string): void {
    consoles.delete(key);
    rememberUrl(key, '');
    if (!views.has(key)) return;
    const next = new Map(views);
    next.delete(key);
    views = next;
    for (const listener of listeners) listener();
  },
};
