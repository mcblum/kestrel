// HTTP routes for a project's saved actions (shared/saved-actions.ts). Shaped like
// start-base/api.ts. The UI's only: no Kestrel tool reaches them. Running one is a terminal
// message (`term-action`, terminal-socket.ts), which names an action by id and never carries a
// command.
//
//   GET /api/saved-actions                              200 { actions: ActionsByProject }
//   PUT /api/saved-actions  { projectId, actions: [] }  200 { actions } | 400 { error }
import { actionsProblem } from '../shared/saved-actions.ts';
import type { Workspace } from '../workspace.ts';
import type { SavedActionsPrefs } from './prefs.ts';

export type SavedActionsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): SavedActionsAnswer => ({ status: 400, body: { error } });

export async function savedActionsRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: Pick<Workspace, 'state'>, prefs: SavedActionsPrefs): Promise<SavedActionsAnswer | null> {
  if (parts[1] !== 'saved-actions' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { actions: await prefs.all() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!(await workspace.state()).projects.some((p) => p.id === projectId)) return bad('No such project.');
  const problem = actionsProblem(body.actions);
  if (problem) return bad(problem);
  return { status: 200, body: { actions: await prefs.set(projectId, body.actions as unknown[]) } };
}
