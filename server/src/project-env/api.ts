// HTTP routes for the environment settings (shared/project-env.ts). Shaped like start-base/api.ts.
// The UI's only: no Kestrel tool reaches them, so an agent cannot give itself variables or have
// files copied.
//
//   GET /api/project-env                                    200 { env: EnvByScope }
//   PUT /api/project-env  { scope, vars, files, copy }      200 { env } | 400 { error }
//
// `scope` is a project's id, or "*" for what every project gets.
import { envProblem, GLOBAL_ENV, sanitizeEnv } from '../shared/project-env.ts';
import type { Workspace } from '../workspace.ts';
import type { ProjectEnvPrefs } from './prefs.ts';

export type ProjectEnvAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): ProjectEnvAnswer => ({ status: 400, body: { error } });

export async function projectEnvRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: Pick<Workspace, 'state'>, prefs: ProjectEnvPrefs): Promise<ProjectEnvAnswer | null> {
  if (parts[1] !== 'project-env' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { env: await prefs.all() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const scope = typeof body.scope === 'string' ? body.scope : '';
  if (scope !== GLOBAL_ENV && !(await workspace.state()).projects.some((p) => p.id === scope)) return bad('No such project.');
  const problem = envProblem(body);
  if (problem) return bad(problem);
  return { status: 200, body: { env: await prefs.set(scope, sanitizeEnv(body)) } };
}
