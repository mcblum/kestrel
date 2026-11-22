// Back and forward (0.0.23): where the user has been, in the order they went there, as a browser
// keeps it. One history for the window, not one per tab: what is in front is one place at a time,
// whichever tab shows it. A place is a session or a page by its route; an unsent New session
// screen is not one (there is nothing to come back to once it is sent or closed). Kept for the
// window only, like scroll position: it is not server data. Pure and browser-safe.
import type { Tab } from './tabs.ts';

export type Place = { kind: 'session'; sessionId: string } | { kind: 'page'; path: string };

export interface NavHistory {
  /** Oldest first. */
  entries: readonly Place[];
  /** Where the user is now in `entries`; -1 when there are none. */
  index: number;
}

export const MAX_PLACES = 100;
export const EMPTY_HISTORY: NavHistory = { entries: [], index: -1 };

/** The place a tab shows, or null for an unsent New session screen. */
export function placeOf(tab: Tab | undefined): Place | null {
  if (tab?.kind === 'session') return { kind: 'session', sessionId: tab.sessionId };
  if (tab?.kind === 'page') return { kind: 'page', path: tab.path };
  return null;
}

export const samePlace = (a: Place | null | undefined, b: Place | null | undefined): boolean =>
  !!a && !!b && a.kind === b.kind && (a.kind === 'session' ? a.sessionId === (b as typeof a).sessionId : a.path === (b as typeof a).path);

/** The place the user is at, or null before the first. */
export const currentPlace = (h: NavHistory): Place | null => h.entries[h.index] ?? null;

/**
 * The user went somewhere. Going where they already are changes nothing; going anywhere else drops
 * what was ahead (as a browser does after Back), and the oldest places past `MAX_PLACES`.
 */
export function visit(h: NavHistory, place: Place): NavHistory {
  if (samePlace(currentPlace(h), place)) return h;
  const kept = [...h.entries.slice(0, h.index + 1), place].slice(-MAX_PLACES);
  return { entries: kept, index: kept.length - 1 };
}

/**
 * One step back (-1) or forward (1), to the nearest place that is still there: `exists` says
 * whether a place can still be shown (a session may have been deleted since). Null when there is
 * nowhere to go that way.
 */
export function step(h: NavHistory, direction: -1 | 1, exists: (place: Place) => boolean = () => true): { history: NavHistory; place: Place } | null {
  for (let i = h.index + direction; i >= 0 && i < h.entries.length; i += direction) {
    const place = h.entries[i]!;
    if (exists(place)) return { history: { entries: h.entries, index: i }, place };
  }
  return null;
}

export const canStep = (h: NavHistory, direction: -1 | 1, exists?: (place: Place) => boolean): boolean => step(h, direction, exists) !== null;
