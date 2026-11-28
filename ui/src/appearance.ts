// How Kestrel looks in this window (server: shared/appearance.ts), remembered in this browser only,
// like the diff view's choice (diffView.ts): a convenience of the window, not server data. A
// change is put on the page's root element at once: the colour scheme every light-dark() colour
// follows, the code font, the message box's text size and the conversation's text scale, and what the high-contrast and diff-colour rules key on
// (styles/appearance.css). The terminal and drawn widgets, which hold colours of their own, listen.
import { useSyncExternalStore } from 'react';
import { DEFAULT_APPEARANCE, isDark, rootLook, sanitizeAppearance, type Appearance } from '@kestrel/server/appearance';

const KEY = 'kestrel.appearance';
const listeners = new Set<() => void>();
const systemDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function read(): Appearance {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? sanitizeAppearance(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

let current: Appearance = read();

function apply(): void {
  const root = document.documentElement;
  const look = rootLook(current);
  root.style.colorScheme = look.colorScheme;
  for (const [name, value] of Object.entries(look.properties)) root.style.setProperty(name, value);
  root.dataset.contrast = look.contrast;
  root.dataset.diff = look.diff;
}

export const appearance = (): Appearance => current;

/** Whether a look has ever been chosen in this browser; false means it is still the default. */
export function appearanceChosen(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** Whether the window is drawn dark now. */
export const drawnDark = (): boolean => isDark(current.theme, systemDark?.matches ?? false);

export function setAppearance(patch: Partial<Appearance>): void {
  const next = sanitizeAppearance({ ...current, ...patch });
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the choice still holds for this window.
  }
  apply();
  for (const listener of listeners) listener();
}

/** Told when the look changes: a choice here, or the system switching while the theme is left to it. Returns the undo. */
export function onAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useAppearance = (): Appearance => useSyncExternalStore(onAppearance, appearance);

/** Put the remembered look on the page. Called once, before the app is drawn. */
export function installAppearance(): void {
  apply();
  systemDark?.addEventListener('change', () => listeners.forEach((listener) => listener()));
}
