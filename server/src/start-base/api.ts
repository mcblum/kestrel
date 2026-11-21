// HTTP routes for where a new session starts (shared/start-base.ts). Shaped like project-edits/api.ts:
// the caller hands over the path parts and a body reader, and gets an answer, or null when the path
// is not this one. The UI's only; no Kestrel tool reaches them.
//
//   POST /api/start-base/check  { projectId, folderId? }              200 { question: BaseQuestion | null } | 400 { error }
//   GET  /api/start-base                                              200 { prefs }
//   PUT  /api/start-base        { projectId, choice: BaseChoice | null } 200 { prefs } | 400 { error }
import type { Workspace } from '../workspace.ts';
import { chosenFolder } from '../runtime/projects.ts';
import { AUTOMATIC, type GitDefaults } from '../shared/git-defaults.ts';
import { isBaseChoice, type BaseQuestion } from '../shared/start-base.ts';
import { checkoutState } from './check.ts';
import type { StartBase } from './prefs.ts';

export type StartBaseAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): StartBaseAnswer => ({ status: 400, body: { error } });
const id = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null);

/** The question for a new session in this project and directory; null when there is nothing to ask. */
export async function baseQuestion(workspace: Pick<Workspace, 'state'>, startBase: StartBase, projectId: string, folderId: string | null, defaults: GitDefaults = AUTOMATIC): Promise<BaseQuestion | null> {
  const project = (await workspace.state()).projects.find((p) => p.id === projectId);
  if (!project) return null;
  const folder = chosenFolder(project, folderId);
  if (!folder?.isGit || (await startBase.remembered(project.id))) return null;
  const state = await checkoutState(folder.path, defaults);
  return state && { projectId: project.id, projectName: project.name, ...state };
}

export async function startBaseRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: Pick<Workspace, 'state'>, startBase: StartBase, defaultsOf: (projectId: string) => Promise<GitDefaults> = async () => AUTOMATIC): Promise<StartBaseAnswer | null> {
  if (parts[1] !== 'start-base') return null;
  if (parts.length === 3 && parts[2] === 'check' && method === 'POST') {
    const body = await readBody();
    const projectId = id(body.projectId);
    if (!projectId) return bad('projectId is required.');
    return { status: 200, body: { question: await baseQuestion(workspace, startBase, projectId, id(body.folderId), await defaultsOf(projectId)) } };
  }
  if (parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { prefs: await startBase.prefs() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const projectId = id(body.projectId);
  if (!projectId) return bad('projectId is required.');
  if (body.choice !== null && !isBaseChoice(body.choice)) return bad('choice must be "default", "current" or null.');
  return { status: 200, body: { prefs: await startBase.remember(projectId, body.choice) } };
}
