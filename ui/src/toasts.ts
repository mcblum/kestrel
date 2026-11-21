// The toasts on screen (shared/toasts.ts): what Kestrel just did, some with an Undo. View state, not
// server data, so it is a small store of its own like the open menu's (menuState.ts). Each toast
// leaves by itself after a while; Undo, its ✕, or the undo key take it away at once.
import { useSyncExternalStore } from 'react';
import { toastDuration, undoable, withoutToast, withToast, type Toast } from '@kestrel/server/toasts';

let list: readonly Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const set = (next: readonly Toast[]) => {
  // A toast pushed out, dismissed or undone no longer needs its timer.
  const kept = new Set(next.map((t) => t.id));
  for (const [id, timer] of timers) {
    if (kept.has(id)) continue;
    clearTimeout(timer);
    timers.delete(id);
  }
  list = next;
  listeners.forEach((l) => l());
};

export const toasts = {
  /** Say what was just done; with `undo`, offer to take it back. */
  show(message: string, undo?: Toast['undo']): void {
    const toast: Toast = { id: nextId++, message, ...(undo ? { undo } : {}) };
    set(withToast(list, toast));
    timers.set(toast.id, setTimeout(() => toasts.dismiss(toast.id), toastDuration(toast)));
  },
  dismiss(id: number): void {
    set(withoutToast(list, id));
  },
  /** Undo what a toast announced: it leaves first, so it cannot be undone twice. */
  undo(id: number): void {
    const toast = list.find((t) => t.id === id);
    if (!toast?.undo) return;
    toasts.dismiss(id);
    void toast.undo();
  },
  /** Undo the newest thing that can be undone; false when there is nothing. */
  undoLatest(): boolean {
    const toast = undoable(list);
    if (!toast) return false;
    toasts.undo(toast.id);
    return true;
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useToasts = (): readonly Toast[] => useSyncExternalStore(subscribe, () => list);
