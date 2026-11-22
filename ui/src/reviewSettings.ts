// Settings → Code reviews, as the UI holds it: one entry in the app store (useResource),
// read by the setting itself, the sidebar (whether it has the CODE REVIEWS section and the Code
// reviews row, and how many requests the section lists) and the Code reviews page.
import { DEFAULT_REVIEW_SETTINGS, sanitizeReviewSettings, type ReviewSettings } from '@kestrel/server/review-settings';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from './data/resources.ts';
import { act, call, putResource } from './store.ts';

export const REVIEW_SETTINGS_PATH = '/api/review-settings';
export const asReviewSettings = (raw: unknown): Sourced<ReviewSettings> => ready(sanitizeReviewSettings(raw));

/** Store a change, and hold what the server stored. */
export const saveReviewSettings = async (change: Partial<ReviewSettings> & { confirmed?: boolean }): Promise<void> => {
  const stored = await act(() => call<ReviewSettings>(REVIEW_SETTINGS_PATH, { method: 'PUT', body: JSON.stringify(change) }));
  if (stored) putResource(REVIEW_SETTINGS_PATH, ready(sanitizeReviewSettings(stored)));
};

/** The setting as it is; the default until the server has answered, or when it cannot. */
export function useReviewSettings(): ReviewSettings {
  const loaded = useResource(REVIEW_SETTINGS_PATH, asReviewSettings).value;
  return loaded.state === 'ready' ? loaded.value : DEFAULT_REVIEW_SETTINGS;
}
