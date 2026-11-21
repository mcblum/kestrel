// Pins: sessions, projects and groups the user keeps at the top of the sidebar. Pure, shared with
// the UI. Stored server-side (one row per pin, with its place in the list), so every window shows
// the same list in the same order. A new pin goes to the end; the user drags them into any order.
import type { Pin, PinKind } from '../model.ts';

export const PIN_KINDS: readonly PinKind[] = ['session', 'project', 'group', 'review'];

/** A pin without its date: what an order is made of. */
export type PinRef = Pick<Pin, 'kind' | 'id'>;

/** The most pins an order may list; far more than a sidebar shows. */
const MAX_PINS = 1000;
/** A review request's key is its host, repository path and number, so longer than an id. */
export const MAX_PIN_ID_LENGTH = 300;

export const isPinKind = (value: unknown): value is PinKind => PIN_KINDS.includes(value as PinKind);

export const isPinned = (pins: readonly PinRef[], kind: PinKind, id: string): boolean => pins.some((p) => p.kind === kind && p.id === id);

/** One string per pin, for sets and comparisons. */
export const pinKey = (pin: PinRef): string => `${pin.kind}:${pin.id}`;

/** What is in sight, by kind: the ids of the sessions, projects and groups the sidebar lists. */
export interface InSight {
  sessions: ReadonlySet<string>;
  projects: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

/** The pins whose item is in sight (not archived, not inside something archived), in the user's order. */
export function visiblePins(pins: readonly Pin[], shown: InSight): Pin[] {
  // A pinned review request is always kept: whether its request is still listed is known only to
  // the review-request store, so the sidebar leaves out the ones that are not (pinned-homes.ts).
  const set: Record<PinKind, ReadonlySet<string> | null> = { session: shown.sessions, project: shown.projects, group: shown.groups, review: null };
  return pins.filter((p) => set[p.kind]?.has(p.id) ?? true);
}

/** An order as the client sent it: a list of `{ kind, id }`, each once. Anything else is a reason. */
export function parsePinOrder(value: unknown): PinRef[] | { reason: string } {
  if (!Array.isArray(value) || value.length > MAX_PINS) return { reason: 'pins must be a list of { kind, id }' };
  const refs: PinRef[] = [];
  for (const entry of value) {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (!isPinKind(e.kind) || typeof e.id !== 'string' || !e.id || e.id.length > MAX_PIN_ID_LENGTH) return { reason: 'each pin needs a kind (session, project, group or review) and an id' };
    refs.push({ kind: e.kind, id: e.id });
  }
  return new Set(refs.map(pinKey)).size === refs.length ? refs : { reason: 'a pin is listed twice' };
}

/** Does `order` list exactly the pins in `current`, each once, in any order? */
export function isPermutation(current: readonly PinRef[], order: readonly PinRef[]): boolean {
  if (current.length !== order.length) return false;
  const keys = new Set(current.map(pinKey));
  return order.every((p) => keys.has(pinKey(p))) && new Set(order.map(pinKey)).size === order.length;
}

/**
 * The whole stored order after the user reordered the pins in sight. The ones in sight take the
 * new order in the places they held; the ones out of sight (inside something archived) keep theirs.
 */
export function storedPinOrder(stored: readonly PinRef[], visibleOrder: readonly PinRef[]): PinRef[] {
  const moving = new Set(visibleOrder.map(pinKey));
  let next = 0;
  return stored.map((pin) => (moving.has(pinKey(pin)) ? visibleOrder[next++]! : pin));
}

/**
 * The pins after `moving` is dropped beside `target` (before it, or after it), or at the end when
 * there is no target. `moving` need not be pinned yet: dropping it is how it gets pinned.
 */
export function placePin<T extends PinRef>(pins: readonly T[], moving: T, target: PinRef | null, after: boolean): T[] {
  const rest = pins.filter((p) => pinKey(p) !== pinKey(moving));
  const at = target === null ? -1 : rest.findIndex((p) => pinKey(p) === pinKey(target));
  const index = at === -1 ? rest.length : at + (after ? 1 : 0);
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}
