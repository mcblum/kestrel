// HTTP route for Settings → Git. Shaped like suggestions/api.ts: the caller hands over the path parts
// and a body reader, and gets an answer, or null when the path is not this one.
//
//   GET   /api/git-settings                                       200 { branchPrefix, startFromLatest, username }
//   PATCH /api/git-settings  { branchPrefix?: { choice, custom }, startFromLatest?: boolean }
//                                                                 200 { branchPrefix, startFromLatest, username } | 400 { error }
//   GET   /api/request-attention                                  200 { prefs: AttentionPrefs }
//   PATCH /api/request-attention  { reason, watch?, card? }        200 { prefs } | 400 { error }
//     Settings → Git → Pull requests that need you. Its own path so reading it never asks who gh is signed in as.
import { GitPrefsRefused, type GitPrefs } from './prefs.ts';

export type GitSettingsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function gitSettingsRoute(parts: readonly string[], method: string, readBody: ReadBody, prefs: GitPrefs): Promise<GitSettingsAnswer | null> {
  if (parts[1] === 'request-attention' && parts.length === 2) return attentionRoute(method, readBody, prefs);
  if (parts[1] !== 'git-settings' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await prefs.view() };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (body.branchPrefix === undefined && body.startFromLatest === undefined) return { status: 400, body: { error: 'Nothing to change: send branchPrefix or startFromLatest.' } };
  try {
    if (body.branchPrefix !== undefined) await prefs.setBranchPrefix(body.branchPrefix);
    if (body.startFromLatest !== undefined) await prefs.setStartFromLatest(body.startFromLatest);
    return { status: 200, body: await prefs.view() };
  } catch (error) {
    if (error instanceof GitPrefsRefused) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

async function attentionRoute(method: string, readBody: ReadBody, prefs: GitPrefs): Promise<GitSettingsAnswer | null> {
  if (method === 'GET') return { status: 200, body: { prefs: await prefs.attention() } };
  if (method !== 'PATCH') return null;
  try {
    return { status: 200, body: { prefs: await prefs.setAttention(await readBody()) } };
  } catch (error) {
    if (error instanceof GitPrefsRefused) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
