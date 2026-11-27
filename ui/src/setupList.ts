// Set up this computer (docs/designs/onboarding.md): the list is asked for by route and held once in
// the store's resources (`useResource`); nothing here keeps a copy. Opening Connections tells the
// server to write this computer's set-up record again if it changed.
import { ready, unavailable, type Sourced } from '@kestrel/server/sourced';
import { setupLeft, type SetupList } from '@kestrel/server/setup-list';
import { useResource } from './data/resources.ts';
import { call } from './store.ts';

export const SETUP_PATH = '/api/connect/setup';

/** GET /api/connect/setup, checked for shape. */
export function asSetupList(raw: unknown): Sourced<SetupList> {
  const r = raw as Partial<SetupList> | null;
  if (!r || !Array.isArray(r.lines) || !Array.isArray(r.others) || typeof r.here !== 'object') return unavailable('Kestrel could not read the set-up list.');
  return ready({ here: r.here as SetupList['here'], others: r.others, lines: r.lines, problems: Array.isArray(r.problems) ? r.problems : [] });
}

/** Connections was opened: the server rewrites this computer's record when it changed. */
export function setupRecordRefresh(): void {
  void call(`${SETUP_PATH}/record`, { method: 'POST' }).catch(() => undefined);
}

/**
 * How many steps of Set up this computer are left, for the number beside Settings and Finish set up: 0 with
 * no account, no other computer, or nothing left. The list is the one held copy the page reads and refreshes,
 * asked once when the window opens; nothing here checks on a timer.
 */
export function useSetupLeft(): number {
  const { value } = useResource(SETUP_PATH, asSetupList);
  return value.state === 'ready' && value.value.others.length > 0 ? setupLeft(value.value) : 0;
}

/** The number's words, for a tooltip and a screen reader. */
export const setupLeftText = (left: number): string => `${left} ${left === 1 ? 'step' : 'steps'} left to set up this computer`;
