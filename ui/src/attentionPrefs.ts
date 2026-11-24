// Settings → Git → Pull requests that need you (server: git-settings/prefs.ts), held once in the store
// as the route's resource. Every place that says a request needs the user reads it: the row's request
// mark, the Overview, the notifier; the Settings part edits the same entry. The card's "Don't ask again"
// changes it on the server, and the Settings part asks again whenever it is opened.
import { DEFAULT_ATTENTION_PREFS, sanitizeAttentionPrefs, type AttentionPrefs, type AttentionReason, type ReasonPrefs } from '@kestrel/server/request-attention';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { fetchResource, useResource } from './data/resources.ts';
import { act, appStore, call, putResource } from './store.ts';

export const ATTENTION_PATH = '/api/request-attention';

type Answer = { prefs?: unknown };
export const asAttentionPrefs = (raw: unknown): Sourced<AttentionPrefs> => ready(sanitizeAttentionPrefs((raw as Answer | null)?.prefs));

const held = (value: Sourced<AttentionPrefs> | undefined): AttentionPrefs => (value?.state === 'ready' ? value.value : DEFAULT_ATTENTION_PREFS);
const settled = (): boolean => true;

/** For a row or a page: the held choices (the defaults until the server's arrive), asked for once. */
export function useAttentionPrefs(): AttentionPrefs {
  return held(useResource(ATTENTION_PATH, asAttentionPrefs, '', settled).value);
}

/** For the Settings part: asked again each time it is opened, so a card's "Don't ask again" shows. */
export const useAttentionSetting = () => useResource(ATTENTION_PATH, asAttentionPrefs);

/** Outside React (the notifier): what is held now, and ask once when nothing is. */
export function heldAttentionPrefs(): AttentionPrefs {
  const value = appStore.get().resources.get(ATTENTION_PATH) as Sourced<AttentionPrefs> | undefined;
  if (value === undefined) void fetchResource(ATTENTION_PATH, asAttentionPrefs);
  return held(value);
}

/** Save one reason's choice as it is changed, and hold the server's answer. */
export const changeAttention = (reason: AttentionReason, change: Partial<ReasonPrefs>) =>
  act(async () => {
    const answer = await call<Answer>(ATTENTION_PATH, { method: 'PATCH', body: JSON.stringify({ reason, ...change }) });
    putResource(ATTENTION_PATH, asAttentionPrefs(answer));
  });
