// What Settings → Archived should search for when it is opened from somewhere else (Search, picking
// an archived session, which cannot be opened as a tab). View state only, handed over once: the page
// takes it into its own search box and it is gone, so coming back later starts empty as before.
import { useEffect, useSyncExternalStore } from 'react';

let asked: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Settings → Archived, when it shows next (or now, if it is open), searches for `text`. */
export function searchArchivedFor(text: string): void {
  asked = text;
  version += 1;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Calls `apply` with what was asked for, once, when the page mounts and whenever it is asked again. */
export function useArchivedQuery(apply: (text: string) => void): void {
  const asking = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (asked === null) return;
    const text = asked;
    asked = null;
    apply(text);
  }, [asking, apply]);
}
