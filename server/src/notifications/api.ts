// HTTP route for Settings → Workflow → Notifications (shared/notifications.ts). Shaped like
// commands-kept/api.ts. The UI's only; no Kestrel tool reaches it.
//
//   GET /api/notifications                               200 { prefs: NotifyPrefs }
//   PUT /api/notifications  { banner, sound, events }    200 { prefs } | 400 { error }
import { notifyProblem, sanitizeNotify } from '../shared/notifications.ts';
import type { NotifyPrefsStore } from './prefs.ts';

export type NotifyAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function notificationsRoute(parts: readonly string[], method: string, readBody: ReadBody, store: NotifyPrefsStore): Promise<NotifyAnswer | null> {
  if (parts[1] !== 'notifications' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { prefs: await store.prefs() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const problem = notifyProblem(body);
  if (problem) return { status: 400, body: { error: problem } };
  return { status: 200, body: { prefs: await store.set(sanitizeNotify(body)) } };
}
