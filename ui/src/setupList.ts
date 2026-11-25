// Set up this computer (docs/designs/onboarding.md): the list is asked for by route and held once in
// the store's resources (`useResource`); nothing here keeps a copy. Opening Connections tells the
// server to write this computer's set-up record again if it changed.
import { ready, unavailable, type Sourced } from '@kestrel/server/sourced';
import type { SetupList } from '@kestrel/server/setup-list';
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
