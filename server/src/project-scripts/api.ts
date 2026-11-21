// HTTP routes for a project's setup and archive scripts (shared/project-scripts.ts). Shaped like
// start-base/api.ts. The UI's only: no Kestrel tool reaches them, so an agent cannot write a script
// that Kestrel would then run outside its sandbox.
//
//   GET /api/project-scripts                                   200 { scripts: ScriptsByProject }
//   PUT /api/project-scripts  { projectId, setup, archive }    200 { scripts } | 400 { error }
import { scriptProblem } from '../shared/project-scripts.ts';
import type { Workspace } from '../workspace.ts';
import type { ProjectScriptsPrefs } from './prefs.ts';

export type ProjectScriptsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): ProjectScriptsAnswer => ({ status: 400, body: { error } });

export async function projectScriptsRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: Pick<Workspace, 'state'>, prefs: ProjectScriptsPrefs): Promise<ProjectScriptsAnswer | null> {
  if (parts[1] !== 'project-scripts' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { scripts: await prefs.all() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!(await workspace.state()).projects.some((p) => p.id === projectId)) return bad('No such project.');
  const problem = scriptProblem(body.setup) ?? scriptProblem(body.archive);
  if (problem) return bad(problem);
  return { status: 200, body: { scripts: await prefs.set(projectId, { setup: (body.setup as string).trim() ? (body.setup as string) : '', archive: (body.archive as string).trim() ? (body.archive as string) : '' }) } };
}
