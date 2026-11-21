// Toasts: short notes at the bottom of the window saying what Kestrel just did, some with an Undo.
// Pure and browser-safe: what is held, how many, and for how long. The UI's store (ui/src/toasts.ts)
// keeps the list and the timers; ToastHost draws it.

export interface Toast {
  id: number;
  message: string;
  /** What Undo does, when the thing can be undone. Run at most once. */
  undo?: () => void | Promise<unknown>;
}

/** How many are shown at once; a new one past it pushes the oldest out. */
export const MAX_TOASTS = 3;
/** How long a note stays, and how long one with an Undo does: long enough to read it and reach the button. */
export const TOAST_MS = 4_000;
export const UNDO_TOAST_MS = 8_000;

export const toastDuration = (toast: Pick<Toast, 'undo'>): number => (toast.undo ? UNDO_TOAST_MS : TOAST_MS);

/** The list with a toast added at its end, the oldest dropped past MAX_TOASTS. Pure. */
export function withToast(list: readonly Toast[], toast: Toast): Toast[] {
  const next = [...list, toast];
  return next.slice(Math.max(0, next.length - MAX_TOASTS));
}

export const withoutToast = (list: readonly Toast[], id: number): Toast[] => list.filter((t) => t.id !== id);

/** The toast ⌘Z undoes: the newest one that can be undone. */
export const undoable = (list: readonly Toast[]): Toast | undefined => [...list].reverse().find((t) => t.undo);

/** "1 review request", "12 review requests". */
export const counted = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
