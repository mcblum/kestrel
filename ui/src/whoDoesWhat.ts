// The model presets and the "Who does what" table (server: shared/who-does-what.ts,
// who-does-what/api.ts), held once in the app store through useResource. Every view that shows or
// edits them reads this entry, and a save writes back what the server stored.
import { NOBODY, type WhoDoesWhat } from '@kestrel/server/who-does-what';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from './data/resources.ts';
import { act, call, putResource } from './store.ts';

export const WHO_DOES_WHAT_PATH = '/api/who-does-what';
const asWho = (raw: unknown): Sourced<WhoDoesWhat> => ready({ ...NOBODY, ...(raw as Partial<WhoDoesWhat>) });

/** The record, loading or not. */
export const useWhoDoesWhatResource = () => useResource(WHO_DOES_WHAT_PATH, asWho).value;

/** The record; nothing set until it has loaded (or when the server is too old to have it). */
export function useWhoDoesWhat(): WhoDoesWhat {
  const loaded = useWhoDoesWhatResource();
  return loaded.state === 'ready' ? loaded.value : NOBODY;
}

/** Save the whole record. True when it was stored; a refusal is shown as the app's error. */
export async function saveWhoDoesWhat(next: Omit<WhoDoesWhat, 'presets'> & { presets: readonly unknown[] }): Promise<boolean> {
  const stored = await act(() => call<WhoDoesWhat>(WHO_DOES_WHAT_PATH, { method: 'PUT', body: JSON.stringify(next) }));
  if (stored) putResource(WHO_DOES_WHAT_PATH, ready(stored));
  return Boolean(stored);
}
