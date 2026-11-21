// HTTP route for Settings → Workflow → "Delegation limits". Shaped like project-edits/api.ts. Behind
// the same token, Origin and Host checks as every route; it is the UI's only, and no Kestrel tool
// reaches it (the agent-facing MCP route serves tools only): an agent cannot raise its own limits.
//
// Every answer is the whole view: the limits in force and the defaults.
//
//   GET    /api/delegation-limits                                                    200 view
//   PUT    /api/delegation-limits  { maxChildrenPerDelegate, maxDepth, maxLiveSessionsPerTree }  200 view | 400 { error }
//   DELETE /api/delegation-limits                       (back to the defaults)        200 view
import type { DelegationLimitsPrefs } from './limits.ts';
import { Refused } from './refused.ts';

export type DelegationLimitsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

async function answer(method: string, readBody: ReadBody, prefs: DelegationLimitsPrefs): Promise<DelegationLimitsAnswer | null> {
  if (method === 'GET') return { status: 200, body: await prefs.view() };
  if (method === 'PUT') return { status: 200, body: await prefs.set(await readBody()) };
  if (method === 'DELETE') return { status: 200, body: await prefs.reset() };
  return null;
}

export async function delegationLimitsRoute(parts: readonly string[], method: string, readBody: ReadBody, prefs: DelegationLimitsPrefs): Promise<DelegationLimitsAnswer | null> {
  if (parts[1] !== 'delegation-limits' || parts.length !== 2) return null;
  try {
    return await answer(method, readBody, prefs);
  } catch (error) {
    if (error instanceof Refused) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
