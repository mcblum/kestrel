// HTTP route for the model presets and the "Who does what" table (shared/who-does-what.ts). The
// UI's only; no Kestrel tool reaches it, so an agent cannot change which agent does what.
//
//   GET /api/who-does-what                                    200 WhoDoesWhat { presets, roles, instruction }
//   PUT /api/who-does-what  { presets, roles, instruction }   200 WhoDoesWhat | 400 { error }
import { whoDoesWhatProblem } from '../shared/who-does-what.ts';
import type { WhoDoesWhatPrefs } from './prefs.ts';

export type WhoDoesWhatAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function whoDoesWhatRoute(parts: readonly string[], method: string, readBody: ReadBody, prefs: WhoDoesWhatPrefs): Promise<WhoDoesWhatAnswer | null> {
  if (parts[1] !== 'who-does-what' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await prefs.current() };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const problem = whoDoesWhatProblem(body);
  if (problem) return { status: 400, body: { error: problem } };
  return { status: 200, body: await prefs.set(body) };
}
