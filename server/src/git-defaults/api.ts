// HTTP routes for a project's Git defaults (shared/git-defaults.ts). Shaped like start-base/api.ts.
// The UI's only; no Kestrel tool reaches them.
//
//   GET /api/git-defaults                                      200 { defaults: GitDefaultsByProject }
//   PUT /api/git-defaults  { projectId, baseBranch, remote }   200 { defaults } | 400 { error }
//   GET /api/git-defaults/choices?project=<id>[&remote=<name>] 200 GitChoices (what the repository offers) | 400 { error }
import { resolve } from 'node:path';
import { git } from '../git.ts';
import { chosenFolder } from '../runtime/projects.ts';
import { DEFAULT_REMOTE, gitDefaultsProblem, gitNameProblem, sanitizeGitDefaults, type GitChoices } from '../shared/git-defaults.ts';
import { defaultBranchOf } from '../start-base/check.ts';
import type { Workspace } from '../workspace.ts';
import type { GitDefaultsPrefs } from './prefs.ts';

export type GitDefaultsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): GitDefaultsAnswer => ({ status: 400, body: { error } });
const lines = (out: string): string[] => out.split('\n').map((line) => line.trim()).filter(Boolean);
const MAX_BRANCHES = 500;

/** The remotes and branches of a repository, and what automatic finds there with `remote`. Local git only. */
export async function gitChoices(repo: string, remote: string): Promise<GitChoices> {
  const ask = (args: string[]) => git(repo, args, { allowFail: true });
  const [remotes, local, tracked, automatic] = await Promise.all([
    ask(['remote']),
    // A branch checked out in another worktree is a session's own, not a base to choose: left out.
    ask(['for-each-ref', '--format=%(refname:short)%09%(worktreepath)', 'refs/heads']).then((out) => lines(out).map((line) => line.split('\t')).filter(([, worktree]) => !worktree || resolve(worktree) === resolve(repo)).map(([name]) => name!).join('\n')),
    ask(['for-each-ref', '--format=%(refname:lstrip=3)', `refs/remotes/${remote}`]),
    defaultBranchOf(repo, { baseBranch: '', remote }),
  ]);
  const branches = [...new Set([...lines(local), ...lines(tracked).filter((name) => name !== 'HEAD')])].sort((a, b) => a.localeCompare(b)).slice(0, MAX_BRANCHES);
  return { remotes: lines(remotes), branches, automaticBranch: automatic?.name ?? null };
}

export async function gitDefaultsRoute(parts: readonly string[], method: string, query: URLSearchParams, readBody: ReadBody, workspace: Pick<Workspace, 'state'>, prefs: GitDefaultsPrefs): Promise<GitDefaultsAnswer | null> {
  if (parts[1] !== 'git-defaults') return null;
  if (parts.length === 3 && parts[2] === 'choices' && method === 'GET') {
    const project = (await workspace.state()).projects.find((p) => p.id === query.get('project'));
    const folder = project && chosenFolder(project, null);
    if (!folder?.isGit) return bad('That project has no git repository.');
    const remote = query.get('remote') || (await prefs.of(project!.id)).remote || DEFAULT_REMOTE;
    const problem = gitNameProblem(remote, 'remote');
    return problem ? bad(problem) : { status: 200, body: await gitChoices(folder.path, remote) };
  }
  if (parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: { defaults: await prefs.all() } };
  if (method !== 'PUT') return null;
  const body = await readBody();
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!(await workspace.state()).projects.some((p) => p.id === projectId)) return bad('No such project.');
  const problem = gitDefaultsProblem(body);
  if (problem) return bad(problem);
  return { status: 200, body: { defaults: await prefs.set(projectId, sanitizeGitDefaults(body)) } };
}
