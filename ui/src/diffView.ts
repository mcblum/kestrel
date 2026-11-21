// How diffs are drawn: unified (one column) or split (old and new side by side), react-diff-view's
// two view types. One choice for every diff in the window, remembered in this browser only (a
// convenience, not server data); unified when nothing is remembered or storage is unavailable.
import { useSyncExternalStore } from 'react';

export type DiffViewType = 'unified' | 'split';
const KEY = 'kestrel.diffView';
const listeners = new Set<() => void>();

function read(): DiffViewType {
  try {
    return window.localStorage.getItem(KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

let current: DiffViewType = read();

export function setDiffView(next: DiffViewType): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Not remembered; the choice still holds for this window.
  }
  for (const listener of listeners) listener();
}

export const useDiffView = (): DiffViewType =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => current,
  );
