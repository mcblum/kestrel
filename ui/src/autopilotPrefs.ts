// Settings → Git → Autopilot (server: git-settings/prefs.ts, shared/autopilot.ts), held once in the store as
// the route's resource. The offer card's "Don't ask again" changes it on the server, and the Settings part
// asks again whenever it is opened.
import { DEFAULT_AUTOPILOT_PREFS, isWanted, sanitizeAutopilotPrefs, type AutopilotPrefs, type AutopilotRecord } from '@kestrel/server/autopilot';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from './data/resources.ts';
import { act, appStore, call, putResource } from './store.ts';
import type { PullRequestDraft } from '@kestrel/server/session-documents';

export const AUTOPILOT_PATH = '/api/autopilot-settings';

type Answer = { prefs?: unknown };
export const asAutopilotPrefs = (raw: unknown): Sourced<AutopilotPrefs> => ready(sanitizeAutopilotPrefs((raw as Answer | null)?.prefs));

/** For the Settings part and the Create pull request form: asked again each time it is shown. */
export const useAutopilotSetting = () => useResource(AUTOPILOT_PATH, asAutopilotPrefs);

/** Save a change as it is made (switches and selects), and hold the server's answer. */
export const changeAutopilot = (change: Partial<AutopilotPrefs> & { confirmed?: boolean }) =>
  act(async () => {
    const answer = await call<Answer>(AUTOPILOT_PATH, { method: 'PATCH', body: JSON.stringify(change) });
    putResource(AUTOPILOT_PATH, asAutopilotPrefs(answer));
  });

/** Turn Autopilot on or off for a session's pull request, or change Merge when green (POST /api/sessions/:id/autopilot). */
export const setSessionAutopilot = (sessionId: string, change: { on: boolean; merge?: boolean }) =>
  act(() => call(`/api/sessions/${encodeURIComponent(sessionId)}/autopilot`, { method: 'POST', body: JSON.stringify(change) }));

/** Outside React (sending the Create form): what is held now; the defaults when nothing is. */
export function heldAutopilotPrefs(): AutopilotPrefs {
  const value = appStore.get().resources.get(AUTOPILOT_PATH) as Sourced<AutopilotPrefs> | undefined;
  return value?.state === 'ready' ? value.value : DEFAULT_AUTOPILOT_PREFS;
}

/**
 * The Create form's Autopilot choice: what the user set in the form, else the session's own (turned on
 * beforehand), else what the settings say (on only with Always).
 */
export function formAutopilot(form: Pick<PullRequestDraft, 'autopilotOn' | 'autopilotMerge'>, prefs: AutopilotPrefs, record: AutopilotRecord | null | undefined): { on: boolean; merge: boolean } {
  const wanted = isWanted(record);
  return { on: form.autopilotOn ?? (wanted || prefs.always), merge: form.autopilotMerge ?? (wanted ? record.merge : prefs.merge) };
}
