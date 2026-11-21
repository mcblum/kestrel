// One Details source from the server: git status, usage, change counts or the repository link. Held
// once in the app store (data/resources.ts) and asked for when a view needs it and again when
// `refreshKey` changes (the session changed). A server that does not have the route yet (the owner's
// server predates it until he restarts) or answers with something else reads as unavailable, never
// as an error or as zero.
import { asSourced, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../../data/resources.ts';
import { RESTART_REASON } from '../../store.ts';

export { RESTART_REASON };
export const needsRestart = (value: Sourced<unknown>) => value.state === 'unavailable' && value.reason === RESTART_REASON;

/** How each validator's answers are read: made once per validator, so the hook's question stays the same. */
const parsers = new WeakMap<object, (raw: unknown) => Sourced<unknown>>();
function parserFor<T>(isValue: (v: unknown) => v is T): (raw: unknown) => Sourced<T> {
  let parse = parsers.get(isValue);
  if (!parse) parsers.set(isValue, (parse = (raw: unknown) => asSourced(raw, isValue, RESTART_REASON)));
  return parse as (raw: unknown) => Sourced<T>;
}

export function useSourced<T>(path: string, isValue: (v: unknown) => v is T, refreshKey: string): { value: Sourced<T>; refresh: () => void } {
  const { value, refresh } = useResource(path, parserFor(isValue), refreshKey);
  return { value, refresh: () => void refresh() };
}
