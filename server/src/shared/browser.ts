// The browser pane, as the server and the UI both see it: which addresses it may open, the
// messages that carry an agent's browser call to the window that has the pane, and the shapes
// of what comes back. The page itself lives in the Electron window (a <webview>); the server
// cannot touch it, so every agent call is a request the UI performs and answers.
//
//   server -> UI:  browser-request  {requestId, sessionId, op, args}
//   UI -> server:  browser-serve    {sessionId, capable}   this window shows the session (capable: it has the pane)
//                  browser-unserve  {sessionId}
//                  browser-response {requestId, ok, result | error}

export const BROWSER_OPS = ['navigate', 'read', 'click', 'type', 'screenshot', 'console'] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];
export const isBrowserOp = (value: unknown): value is BrowserOp => typeof value === 'string' && (BROWSER_OPS as readonly string[]).includes(value);

/** Why an agent's browser call could not run. The UI says the first one too, in the empty pane. */
export const NEEDS_DESKTOP = 'The browser pane needs the desktop app.';
export const NO_WINDOW = 'Open this session in Kestrel to use the browser.';
export const NO_PAGE = 'No page is open in the browser pane. Call browser_navigate first.';

/** The browser's own cookies and storage, apart from the app's. */
export const BROWSER_PARTITION = 'persist:kestrel-browser';

/** How long the UI waits for a page to load before answering anyway. */
export const NAVIGATE_WAIT_MS = 20_000;
/** Pictures wider than this are scaled down before they reach the agent. */
export const SCREENSHOT_MAX_WIDTH = 1600;
export const CONSOLE_KEEP = 200;
export const READ_DEFAULT_CHARS = 20_000;
export const READ_MAX_CHARS = 100_000;
export const TYPE_MAX_CHARS = 10_000;

// ---- addresses --------------------------------------------------------------------------------

/** Hosts that are this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** What the pane must never open: Kestrel's own server (its API) and the origins its UI is served from. */
export interface BrowserGuard {
  serverPort?: number;
  appOrigins?: readonly string[];
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const BLOCKED_SCHEMES: Record<string, string> = {
  'file:': 'file: addresses are not opened in the browser pane. Read local files with your own file tools.',
  'javascript:': 'javascript: addresses are not opened. Use browser_click and browser_type to act on the page.',
  'data:': 'data: addresses are not opened. Write the content to a file and serve it over http, or show it with show_widget.',
};

const portOf = (url: URL) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

/** Whether `url` reaches the server behind `origin`: that origin, or any name for this computer on its port. */
function reachesOrigin(url: URL, origin: string): boolean {
  let app: URL;
  try {
    app = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === app.origin) return true;
  // http://localhost:5173 is the same dev server as http://127.0.0.1:5173, and it hands out the token too.
  return isLoopbackHost(app.hostname) && isLoopbackHost(url.hostname) && portOf(url) === portOf(app);
}

/** Whether the pane may open `raw`, given exactly. Only http and https, and never Kestrel itself. */
export function checkBrowserUrl(raw: string, guard: BrowserGuard = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `"${raw.slice(0, 200)}" is not a full address. Give it with its scheme, like https://example.com.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: BLOCKED_SCHEMES[url.protocol] ?? `${url.protocol} addresses are not opened in the browser pane: only http and https.` };
  if (guard.serverPort !== undefined && isLoopbackHost(url.hostname) && portOf(url) === guard.serverPort) return { ok: false, reason: "That address is Kestrel's own server. The browser pane does not open Kestrel's API." };
  if (guard.appOrigins?.some((origin) => reachesOrigin(url, origin))) return { ok: false, reason: "That address is Kestrel's own interface. The browser pane does not open Kestrel itself." };
  return { ok: true, url: url.href };
}

/**
 * What the address field turns typed text into: a scheme is added when there is none (http for
 * this computer, https for everything else). Text is never turned into a search.
 */
export function addressFromInput(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^(about|data|javascript|file|mailto):/i.test(text)) return text;
  const host = text.split(/[/?#]/)[0]!;
  const bare = host.replace(/:\d+$/, '');
  const local = isLoopbackHost(bare) || /^[^.:]+:\d+$/.test(host);
  return `${local ? 'http' : 'https'}://${text}`;
}

// ---- results ------------------------------------------------------------------------------------

/** Where the pane is after a call. */
export interface PageInfo {
  url: string;
  title: string;
}

export interface NavigateResult extends PageInfo {
  /** The page had not finished loading when the wait ran out. */
  timedOut: boolean;
}

/** One thing on the page the agent can act on, numbered by `browser_read`. */
export interface PageElement {
  ref: number;
  /** link, button, textbox, checkbox, combobox, … */
  role: string;
  name: string;
  /** A short extra: the link target, the field's type and value, "disabled". */
  detail?: string;
}

export interface ReadResult extends PageInfo {
  text: string;
  elements: PageElement[];
  /** More elements were on the page than were listed. */
  moreElements: boolean;
}

export interface ActResult extends PageInfo {
  /** What was done, e.g. `Clicked [3] button "Continue"`. */
  done: string;
}

export interface ScreenshotResult extends PageInfo {
  mediaType: string;
  /** base64 */
  data: string;
  width: number;
  height: number;
}

export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error';
export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  /** Where it came from: the script and line, or the address that failed to load. */
  source?: string;
  /** ms since the epoch */
  at: number;
}

export interface ConsoleResult extends PageInfo {
  entries: ConsoleEntry[];
}

/** Chromium's console levels, as a number (0-3) or a name, in our four words. */
export function consoleLevel(level: unknown): ConsoleLevel {
  if (level === 3 || level === 'error') return 'error';
  if (level === 2 || level === 'warning' || level === 'warn') return 'warning';
  if (level === 0 || level === 'verbose' || level === 'debug') return 'debug';
  return 'info';
}

/** Keep the newest `max` entries; the list is never changed in place. */
export function appendConsole(list: readonly ConsoleEntry[], entry: ConsoleEntry, max = CONSOLE_KEEP): ConsoleEntry[] {
  const next = [...list, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
