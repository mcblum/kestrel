// Running a saved action (shared/saved-actions.ts) for a scope: which action the id names, the
// folder it runs in and the variables it gets, and waiting for its preview address to answer.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Project, Session } from '../model.ts';
import { resolveEnv } from '../project-env/resolve.ts';
import type { EnvByScope } from '../shared/project-env.ts';
import { PREVIEW_WAIT_MS, type ActionsByProject, type SavedAction } from '../shared/saved-actions.ts';
import { parseScope } from '../shared/scope.ts';

export type ResolvedAction = { action: SavedAction; cwd: string; env: Record<string, string> } | { refused: string };

export interface ActionDeps {
  state(): Promise<{ sessions: readonly Session[]; projects: readonly Project[] }>;
  actions(): Promise<ActionsByProject>;
  env(): Promise<EnvByScope>;
  /** The scope's working folder (a session's worktree, a project's folder); null when it has none. */
  folderOf(key: string): Promise<string | null | undefined>;
}

/** The action `actionId` of the scope's project, ready to run; or why it cannot be. */
export async function resolveAction(deps: ActionDeps, key: string, actionId: string): Promise<ResolvedAction> {
  const scope = parseScope(key);
  const { sessions, projects } = await deps.state();
  const session = scope?.kind === 'session' ? sessions.find((s) => s.id === scope.id) : undefined;
  const projectId = scope?.kind === 'project' ? scope.id : session?.startedIn;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return { refused: 'Actions belong to a project, and there is none here.' };
  const action = (await deps.actions())[project.id]?.find((a) => a.id === actionId);
  if (!action) return { refused: `${project.name} no longer has that action.` };
  const root = await deps.folderOf(key);
  if (!root || !existsSync(root)) return { refused: `${action.name} has nowhere to run: the working folder is gone.` };
  const cwd = resolve(root, action.folder);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { refused: `${action.name} runs in "${action.folder}", which is not a folder here.` };
  // A link inside the folder must not lead the action somewhere else.
  const realRoot = realpathSync(root);
  const realCwd = realpathSync(cwd);
  if (realCwd !== realRoot && !realCwd.startsWith(realRoot + sep)) return { refused: `${action.name} runs in "${action.folder}", which leads outside the working folder.` };
  const source = project.folders.find((f) => f.id === session?.startedFolderId) ?? project.folders.find((f) => f.id === project.defaultFolderId) ?? project.folders[0];
  const { env } = await resolveEnv(await deps.env(), project.id, source?.path ?? null);
  return { action, cwd, env };
}

export interface PreviewWait {
  /** One request to the address; true when anything answered. */
  probe?: (url: string) => Promise<boolean>;
  waitMs?: number;
  everyMs?: number;
  signal?: AbortSignal;
}

const PROBE_TIMEOUT_MS = 2000;
const answers = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return true; // any answer, an error page included, means something is serving
  } catch {
    return false;
  }
};

/** Waits until the address answers. False when it never did in time, or the wait was ended. */
export async function waitForPreview(url: string, opts: PreviewWait = {}): Promise<boolean> {
  const probe = opts.probe ?? answers;
  const every = opts.everyMs ?? 500;
  const until = Date.now() + (opts.waitMs ?? PREVIEW_WAIT_MS);
  for (;;) {
    if (opts.signal?.aborted) return false;
    if (await probe(url)) return true;
    if (Date.now() + every > until) return false;
    await new Promise((done) => setTimeout(done, every));
  }
}
