// HTTP route for the cleanup policies (shared/cleanup-policy.ts). The UI's only; no Kestrel tool
// reaches it.
//
//   GET /api/cleanup-policy                                          200 { policies: PolicyByScope }
//   PUT /api/cleanup-policy  { scope, policy: CleanupPolicy | null } 200 { policies } | 400 { error }
//
// `scope` is "*" for every project, or a project's id; `policy: null` returns a project to the app-wide one.
import { GLOBAL_POLICY, policyProblem, sanitizePolicy } from '../shared/cleanup-policy.ts';
import type { Workspace } from '../workspace.ts';
import type { CleanupPrefs } from './prefs.ts';

export type CleanupAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): CleanupAnswer => ({ status: 400, body: { error } });

export async function cleanupPolicyRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: Pick<Workspace, 'state'>, prefs: CleanupPrefs): Promise<CleanupAnswer | null> {
  if (parts[1] !== 'cleanup-policy' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { policies: await prefs.all() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const scope = typeof body.scope === 'string' ? body.scope : '';
  if (scope !== GLOBAL_POLICY && !(await workspace.state()).projects.some((p) => p.id === scope)) return bad('No such project.');
  if (body.policy === null) return scope === GLOBAL_POLICY ? bad('The app-wide policy cannot be removed; turn its switches off instead.') : { status: 200, body: { policies: await prefs.set(scope, null) } };
  const problem = policyProblem(body.policy);
  if (problem) return bad(problem);
  return { status: 200, body: { policies: await prefs.set(scope, sanitizePolicy(body.policy)) } };
}
