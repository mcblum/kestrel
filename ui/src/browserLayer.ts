// Every scope's browser page lives here, for the life of the window, not inside its pane: one
// layer at the app's root (BrowserLayer.tsx) holds a box per scope, and each box holds that
// scope's <webview>. A Browser pane only marks where its page goes (a slot); the layer lays the
// box over the slot and hides it (visibility: hidden) when the slot is not on screen. So a page
// keeps running while another page or tab is in front, an agent can drive its session's page in
// the background, and closing a tab loses nothing. A <webview> is never moved to another parent
// (that reloads it). Past LIVE_BROWSER_CAP pages the one used longest ago is closed; its address
// is kept and it loads again when shown. Deleting a session, project or group closes its page.
import { browsersToClose } from '@kestrel/server/browser-cap';
import { parseScope } from '@kestrel/server/scope';
import { WebviewHost } from './browserHost.ts';
import { browserPane } from './browserStore.ts';
import { appStore } from './store.ts';

/** The size a page gets when it is drawn for a picture before it was ever on screen. */
const UNSEEN_SIZE = { width: 1024, height: 768 };

interface Entry {
  readonly key: string;
  readonly box: HTMLDivElement;
  host: WebviewHost;
  /** Where its pane wants it (newest last); empty when no pane shows it. */
  slots: readonly Slot[];
  lastUsed: number;
  busy: number;
  /** Drawn, almost transparent, so a picture can be taken while it is not on screen. */
  backstage: boolean;
  size: { width: number; height: number } | null;
}

interface Slot {
  readonly el: HTMLElement;
  visible: boolean;
}

let root: HTMLElement | null = null;
const entries = new Map<string, Entry>();
let clock = 0;
const tick = () => ++clock;

function makeEntry(key: string): Entry {
  const box = document.createElement('div');
  box.className = 'browser-layer-box';
  box.dataset.scope = key;
  root?.appendChild(box);
  const entry: Entry = { key, box, host: null as unknown as WebviewHost, slots: [], lastUsed: tick(), busy: 0, backstage: false, size: null };
  attachHost(entry);
  entries.set(key, entry);
  return entry;
}

/** A fresh host in the entry's box: made at first, and again after the cap closed its page. */
function attachHost(entry: Entry): void {
  entry.host = new WebviewHost(entry.key, entry.box, () => showForPicture(entry), () => queueMicrotask(trim));
}

/** The page on screen, or drawn behind the app so a picture has something to show. */
function showForPicture(entry: Entry): boolean {
  if (onScreen(entry)) return true;
  if (!entry.backstage) {
    entry.backstage = true;
    place(entry);
  }
  return true;
}

const shownSlot = (entry: Entry): Slot | undefined => entry.slots.at(-1);

function onScreen(entry: Entry): boolean {
  const slot = shownSlot(entry);
  if (!slot?.visible || !slot.el.isConnected) return false;
  const r = slot.el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1;
}

/** Lay the box over its slot, clipped to the columns' scrolling area; or hide it. */
function place(entry: Entry): void {
  const style = entry.box.style;
  const slot = shownSlot(entry);
  if (slot && onScreen(entry)) {
    const r = slot.el.getBoundingClientRect();
    const clip = (slot.el.closest('.pane-columns') ?? slot.el).getBoundingClientRect();
    entry.size = { width: r.width, height: r.height };
    entry.lastUsed = tick();
    Object.assign(style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, visibility: 'visible', opacity: '', pointerEvents: 'auto' });
    const inset = [clip.top - r.top, r.right - clip.right, r.bottom - clip.bottom, clip.left - r.left].map((v) => `${Math.max(0, v)}px`);
    style.clipPath = `inset(${inset.join(' ')})`;
    return;
  }
  const size = entry.size ?? UNSEEN_SIZE;
  Object.assign(style, { width: `${size.width}px`, height: `${size.height}px`, pointerEvents: 'none', clipPath: '' });
  if (entry.backstage) Object.assign(style, { left: '0px', top: '0px', visibility: 'visible', opacity: '0.01' });
  else Object.assign(style, { visibility: 'hidden', opacity: '' });
}

const placeAll = () => entries.forEach(place);

/** Close the pages used longest ago past the cap; each keeps its address for when it is shown again. */
function trim(): void {
  const live = [...entries.values()].filter((e) => e.host.live);
  const close = browsersToClose(live.map((e) => ({ key: e.key, lastUsed: e.lastUsed, onScreen: onScreen(e), busy: e.busy > 0 })));
  for (const key of close) {
    const entry = entries.get(key);
    if (!entry) continue;
    entry.host.destroy();
    attachHost(entry);
  }
}

/** A page whose address is known but which has no <webview> (closed by the cap, or after a reload) loads it now. */
function revive(entry: Entry): void {
  const last = browserPane.view(entry.key).url;
  if (!entry.host.live && last) entry.host.open(last).catch(() => undefined); // a failure shows as the note under the bar
}

function destroy(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entry.host.destroy();
  entry.box.remove();
  browserPane.forget(key);
}

/** Close the pages of sessions, projects and groups that were deleted. */
function dropDeleted(): void {
  const workspace = appStore.get().workspace;
  if (!workspace) return;
  const sessions = new Set([...workspace.sessions, ...workspace.archived.sessions].map((s) => s.id));
  const projects = new Set([...workspace.projects, ...workspace.archived.projects].map((p) => p.id));
  const groups = new Set([...workspace.groups, ...workspace.archived.groups].map((g) => g.id));
  for (const key of [...entries.keys()]) {
    const scope = parseScope(key);
    const known = scope?.kind === 'session' ? sessions : scope?.kind === 'project' ? projects : groups;
    if (scope && !known.has(scope.id)) destroy(key);
  }
}

let observer: ResizeObserver | null = null;

export const browserLayer = {
  /** The layer's element, mounted once at the app's root. Returns the function to call when it goes. */
  mount(el: HTMLElement): () => void {
    root = el;
    for (const entry of entries.values()) el.appendChild(entry.box);
    observer = new ResizeObserver(placeAll);
    const offStore = appStore.subscribe(dropDeleted);
    window.addEventListener('resize', placeAll);
    document.addEventListener('scroll', placeAll, { capture: true, passive: true });
    browserPane.setLayer(browserLayer);
    return () => {
      browserPane.setLayer(null);
      offStore();
      window.removeEventListener('resize', placeAll);
      document.removeEventListener('scroll', placeAll, { capture: true });
      observer?.disconnect();
      observer = null;
      if (root === el) root = null;
    };
  },

  /** The scope's page host, made if there is none. Its page loads its last address if it has one. */
  host(key: string): WebviewHost {
    const entry = entries.get(key) ?? makeEntry(key);
    revive(entry);
    return entry.host;
  },

  /** The host if one exists, without making one. */
  existing: (key: string): WebviewHost | null => entries.get(key)?.host ?? null,

  /** A pane marks where its scope's page goes. Returns the slot's update (is it on) and its removal. */
  slot(key: string, el: HTMLElement): { update(visible: boolean): void; remove(): void } {
    const entry = entries.get(key) ?? makeEntry(key);
    const slot: Slot = { el, visible: false };
    entry.slots = [...entry.slots, slot];
    observer?.observe(el, { box: 'border-box' });
    const layout = el.closest('.pane-layout');
    if (layout) observer?.observe(layout, { box: 'border-box' });
    return {
      update(visible: boolean) {
        slot.visible = visible;
        if (visible) revive(entry);
        place(entry);
      },
      remove() {
        entry.slots = entry.slots.filter((s) => s !== slot);
        observer?.unobserve(el);
        place(entry);
      },
    };
  },

  /** An agent's call runs in the scope's page: it is not closed by the cap meanwhile. */
  async using<T>(key: string, work: (host: WebviewHost) => Promise<T>): Promise<T> {
    const entry = entries.get(key) ?? makeEntry(key);
    entry.busy += 1;
    entry.lastUsed = tick();
    try {
      return await work(entry.host);
    } finally {
      entry.busy -= 1;
      entry.lastUsed = tick();
      if (entry.busy === 0 && entry.backstage) {
        entry.backstage = false;
        place(entry);
      }
      trim();
    }
  },

  /** Lay every box again (a pane moved without changing size). */
  placeAll,
};
