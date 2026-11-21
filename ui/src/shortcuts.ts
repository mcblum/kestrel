// The user's own keyboard shortcuts (server: shared/shortcuts.ts), remembered in this browser only,
// like the appearance (appearance.ts): keys belong to the keyboard in front of the user. A change
// applies at once to the page's own key handling (commands.ts) and is handed to the desktop app,
// whose menu owns the keys there (app/menu.mjs).
import { useSyncExternalStore } from 'react';
import { menuAccelerators, sanitizeOverrides, withBinding, type ShortcutOverrides } from '@kestrel/server/shortcuts';

const KEY = 'kestrel.shortcuts';
const listeners = new Set<() => void>();

function read(): ShortcutOverrides {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? sanitizeOverrides(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

let current: ShortcutOverrides = read();

/** Cmd is the modifier on a Mac, Ctrl elsewhere. */
export const isMac = (): boolean => (window.kestrelShell?.platform ? window.kestrelShell.platform === 'darwin' : /Mac|iPhone|iPad/.test(navigator.platform));

export const shortcuts = (): ShortcutOverrides => current;

function store(next: ShortcutOverrides): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the keys still hold for this window.
  }
  window.kestrelShell?.setShortcuts?.(menuAccelerators(next));
  for (const listener of listeners) listener();
}

/** Give a command a key ('' for none). A key that cannot be given changes nothing (shared/shortcuts.ts `assignProblem` says why). */
export const setShortcut = (id: string, binding: string): void => store(withBinding(current, id, binding));

/** Every command back on its default key. */
export const resetShortcuts = (): void => store(Object.keys(current).length === 0 ? current : {});

export const useShortcuts = (): ShortcutOverrides =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => current,
  );

/** Hand the remembered keys to the desktop app's menu. Called once, as the app starts. */
export function installShortcuts(): void {
  if (Object.keys(current).length > 0) window.kestrelShell?.setShortcuts?.(menuAccelerators(current));
}
