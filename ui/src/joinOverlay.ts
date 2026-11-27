// Which requests to join this window has put aside (issue 72): view state of this window only, never server data
// and never saved. A request put aside is not drawn over the page again, but stays in Settings → Connections; a new
// request is a new id, so it shows. A click on the request's banner brings it back.
import { useSyncExternalStore } from 'react';

let aside: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>): void {
  aside = next;
  for (const listener of listeners) listener();
}

export const joinOverlay = {
  putAside: (id: string): void => (aside.has(id) ? undefined : set(new Set([...aside, id]))),
  bringBack: (id: string): void => {
    if (!aside.has(id)) return;
    const next = new Set(aside);
    next.delete(id);
    set(next);
  },
};

/** The ids put aside in this window. */
export const usePutAside = (): ReadonlySet<string> => useSyncExternalStore((listener) => (listeners.add(listener), () => void listeners.delete(listener)), () => aside);
