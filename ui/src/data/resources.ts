// Server data by route, held once in the app store (`resources`, ui/src/store.ts). Every view that
// shows the same route reads the same entry. A route is asked for when a view first needs it, and
// again when its `refreshKey` changes or Refresh is pressed; what is held stays on screen meanwhile,
// and is replaced only when the answer really changed. Loading shows only the first time.
import { useCallback, useEffect } from 'react';
import { LOADING, unavailable, type Sourced } from '@kestrel/server/sourced';
import { appStore, call, putResource, RESTART_REASON, useApp } from '../store.ts';

const heldAt = (path: string) => appStore.get().resources.get(path);

/** What `call` throws for a path the server does not know (it predates the route). */
const NOT_FOUND = 'Not found';

/** Questions on their way, shared by every view that asks at the same moment. */
const inFlight = new Map<string, Promise<void>>();

export function failure(error: unknown): Sourced<never> {
  const message = error instanceof Error ? error.message : String(error);
  return unavailable(message === NOT_FOUND ? RESTART_REASON : message || 'Kestrel could not ask');
}

/** The route's raw answer, turned into what the store holds. */
export type Parse = (raw: unknown) => Sourced<unknown>;

/** Ask the server for `path` (with `?refresh=1` when `refresh`) and keep the answer in the store under `path`. */
export function fetchResource(path: string, parse: Parse, refresh = false): Promise<void> {
  const url = refresh ? `${path}${path.includes('?') ? '&' : '?'}refresh=1` : path;
  const pending = inFlight.get(url);
  if (pending) return pending;
  const asked = call<unknown>(url)
    .then((raw) => putResource(path, parse(raw)), (error: unknown) => putResource(path, failure(error)))
    .finally(() => inFlight.delete(url));
  inFlight.set(url, asked);
  return asked;
}

/**
 * One route's answer from the store, asked for when the view needs it and whenever `refreshKey`
 * changes. `path` null: nothing to ask (LOADING). `refresh` asks again past the server's caches.
 * `settled`: an answer it accepts is not asked for again (what an agent offers does not change while
 * Kestrel runs).
 */
export function useResource<T>(path: string | null, parse: (raw: unknown) => Sourced<T>, refreshKey = '', settled?: (value: T) => boolean): { value: Sourced<T>; refresh: () => Promise<void> } {
  const held = useApp((s) => (path === null ? undefined : s.resources.get(path))) as Sourced<T> | undefined;
  useEffect(() => {
    if (path === null) return;
    const now = heldAt(path) as Sourced<T> | undefined;
    if (settled && now?.state === 'ready' && settled(now.value)) return;
    void fetchResource(path, parse);
    // `parse` is a module-level function at every call site; a new one does not mean a new question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, refreshKey]);
  // An answer can leave the store while its view is still up: the oldest entries are dropped past
  // the cap, and a hot reload of the store starts it empty. Nothing above would ask again (the path
  // did not change), and the view would say Loading for good, so a missing answer is asked for.
  // A question already on its way is shared (`inFlight`), so the first draw still asks once.
  const missing = path !== null && held === undefined;
  useEffect(() => {
    if (path !== null && missing) void fetchResource(path, parse);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, missing]);
  const refresh = useCallback(() => (path === null ? Promise.resolve() : fetchResource(path, parse, true)), [path, parse]);
  return { value: held ?? LOADING, refresh };
}
