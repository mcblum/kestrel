// What each agent browser call does to the session's pane. The pane (BrowserPane.tsx) gives a
// small driver over its <webview>; the page scripts and their checks are in
// @kestrel/server/browser-scripts. Results go back to the server as data; what a page returns is
// clipped and checked here first and is never acted on by Kestrel.
import { checkBrowserUrl, NO_PAGE, READ_DEFAULT_CHARS, READ_MAX_CHARS, type BrowserGuard, type BrowserOp, type ConsoleEntry, type NavigateResult, type PageInfo } from '@kestrel/server/browser';
import { clickScript, describeElement, focusForTypingScript, parseAct, parseRead, readScript, settleTypedScript, submitScript } from '@kestrel/server/browser-scripts';

/** The parts of Electron's <webview> element the pane uses. Its methods work only after `dom-ready`. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  insertText(text: string): Promise<void>;
  sendInputEvent(event: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string }): Promise<void>;
  getWebContentsId(): number;
}

/** One session's pane, as the calls see it. */
export interface PaneDriver {
  /** The page, once it can take calls; null before the first page. */
  page(): WebviewElement | null;
  /** The property the page-side element map lives under (see browser-scripts.ts). */
  readonly refKey: string;
  info(): PageInfo;
  /** Load an address (making the page if there is none yet) and wait for it, up to 20 seconds. */
  open(url: string): Promise<NavigateResult>;
  /** After a click or Enter: wait for a load it started, briefly. */
  settle(): Promise<void>;
  /** The pane is on screen and painted, so a picture shows the page. */
  painted(): Promise<void>;
  console(): readonly ConsoleEntry[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function needPage(driver: PaneDriver): WebviewElement {
  const page = driver.page();
  if (!page) throw new Error(NO_PAGE);
  return page;
}

/** Run a page script; a page that throws or has gone away is a plain reason. */
async function inPage(page: WebviewElement, script: string): Promise<unknown> {
  try {
    return await page.executeJavaScript(script, true);
  } catch (error) {
    throw new Error(`The page did not run Kestrel's script: ${errorText(error)}`);
  }
}

/** Perform one call. Throws an Error whose message is the reason to give the agent. */
export async function performOp(driver: PaneDriver, op: BrowserOp, args: Record<string, unknown>, guard: BrowserGuard): Promise<object> {
  switch (op) {
    case 'navigate':
      return navigate(driver, args, guard);
    case 'read':
      return read(driver, args);
    case 'click':
      return click(driver, args);
    case 'type':
      return type(driver, args);
    case 'screenshot':
      return screenshot(driver);
    case 'console':
      return { ...driver.info(), entries: driver.console() };
  }
}

async function navigate(driver: PaneDriver, args: Record<string, unknown>, guard: BrowserGuard): Promise<NavigateResult> {
  // Checked by the server already; checked again here, where the page is.
  const checked = checkBrowserUrl(typeof args.url === 'string' ? args.url : '', guard);
  if (!checked.ok) throw new Error(checked.reason);
  return driver.open(checked.url);
}

async function read(driver: PaneDriver, args: Record<string, unknown>): Promise<object> {
  const page = needPage(driver);
  const max = typeof args.maxChars === 'number' ? Math.min(READ_MAX_CHARS, Math.max(1, Math.floor(args.maxChars))) : READ_DEFAULT_CHARS;
  const parsed = parseRead(await inPage(page, readScript(driver.refKey, max)), max);
  return { ...parsed, more: parsed.moreElements };
}

const refFrom = (args: Record<string, unknown>) => (typeof args.ref === 'number' && Number.isSafeInteger(args.ref) ? args.ref : 0);

async function click(driver: PaneDriver, args: Record<string, unknown>): Promise<object> {
  const page = needPage(driver);
  const ref = refFrom(args);
  const outcome = parseAct(await inPage(page, clickScript(driver.refKey, ref)));
  if (!outcome.ok) return { ...driver.info(), outcome };
  await driver.settle();
  return { ...driver.info(), outcome, done: `Clicked ${describeElement(ref, outcome.role, outcome.name)}` };
}

async function type(driver: PaneDriver, args: Record<string, unknown>): Promise<object> {
  const page = needPage(driver);
  const ref = refFrom(args);
  const text = typeof args.text === 'string' ? args.text : '';
  const ready = parseAct(await inPage(page, focusForTypingScript(driver.refKey, ref, text)));
  if (!ready.ok) return { ...driver.info(), outcome: ready };
  const what = describeElement(ref, ready.role, ready.name);
  if (ready.selected) return { ...driver.info(), outcome: ready, done: `Chose "${text}" in ${what}` };
  // Real text input first, so the page sees typing; if it did not land, set the value directly.
  await page.insertText(text).catch(() => undefined);
  const settled = parseAct(await inPage(page, settleTypedScript(driver.refKey, ref, text)));
  if (!settled.ok) return { ...driver.info(), outcome: settled };
  if (args.submit === true) {
    await pressEnter(page, driver.refKey, ref);
    await driver.settle();
  }
  return { ...driver.info(), outcome: ready, done: `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${what}${args.submit === true ? ' and pressed Enter' : ''}` };
}

/** A real Enter key, so the page submits the way it would for a person; a script submit if keys cannot be sent. */
async function pressEnter(page: WebviewElement, refKey: string, ref: number): Promise<void> {
  try {
    for (const type of ['keyDown', 'char', 'keyUp'] as const) await page.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
  } catch {
    await inPage(page, submitScript(refKey, ref));
  }
}

async function screenshot(driver: PaneDriver): Promise<object> {
  const page = needPage(driver);
  const capture = window.kestrelShell?.captureBrowser;
  if (!capture) throw new Error('This version of the desktop app cannot take pictures of the browser pane.');
  await driver.painted();
  const picture = await capture(page.getWebContentsId());
  if (!picture) throw new Error('The browser pane could not take a picture of the page.');
  return { ...driver.info(), ...picture };
}
