// A project's saved actions (0.0.20, matt/kestrel#15): named commands such as Dev server, Test,
// Lint and Build, each with a folder to run in and, for one that serves a page, the address to
// preview. The project owns them; they are run from the Terminal pane of any of its sessions, or
// of its own page, each in a terminal of its own named after it. Pure and browser-safe: the rules
// and the words. (Not ui/src/projectActions.ts, which is the UI's calls for projects and folders.)

export interface SavedAction {
  id: string;
  name: string;
  /** One command line, typed into the action's terminal. */
  command: string;
  /** Where it runs, relative to the session's working folder; '' for that folder itself. */
  folder: string;
  /** The address to open in the browser pane once it answers; '' for none. */
  previewUrl: string;
}

/** Every project's actions, by project id, in the order the user keeps them; a project with none is absent. */
export type ActionsByProject = Readonly<Record<string, readonly SavedAction[]>>;

export const MAX_ACTIONS = 20;
export const MAX_ACTION_NAME = 40;
export const MAX_ACTION_COMMAND = 2000;
const MAX_FOLDER = 300;
const MAX_URL = 500;
/** How long an action's preview address is waited for after it starts. */
export const PREVIEW_WAIT_MS = 60_000;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Why `folder` cannot be where an action runs, or null when it can. */
export function actionFolderProblem(folder: string): string | null {
  if (folder.startsWith('/') || folder.startsWith('~')) return 'The folder is relative to the session\'s working folder, like "ui" or "packages/api".';
  if (folder.split('/').includes('..')) return 'The folder cannot reach outside the session\'s working folder.';
  return folder.length > MAX_FOLDER ? 'That folder path is too long.' : null;
}

/** Why `url` cannot be previewed, or null when it can ('' is no preview). */
export function previewUrlProblem(url: string): string | null {
  if (!url) return null;
  if (url.length > MAX_URL) return 'That address is too long.';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? null : 'The preview address must start with http:// or https://.';
  } catch {
    return 'Give the preview address in full, like http://localhost:5173.';
  }
}

/** Why one action cannot be saved, or null when it can. `value` is what a client sent. */
export function actionProblem(value: unknown): string | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const name = str(v.name);
  const command = str(v.command);
  if (!name) return 'Give every action a name.';
  if (name.length > MAX_ACTION_NAME) return `"${name.slice(0, 20)}…": a name can be at most ${MAX_ACTION_NAME} characters.`;
  if (!command) return `${name}: give it a command to run.`;
  if (command.includes('\n')) return `${name}: the command is one line. Put a longer one in a script file and run that.`;
  if (command.length > MAX_ACTION_COMMAND) return `${name}: the command can be at most ${MAX_ACTION_COMMAND} characters.`;
  const problem = actionFolderProblem(str(v.folder)) ?? previewUrlProblem(str(v.previewUrl));
  return problem ? `${name}: ${problem}` : null;
}

/** Why this list cannot be a project's actions, or null when it can. */
export function actionsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'Send the actions as a list.';
  if (value.length > MAX_ACTIONS) return `A project can have at most ${MAX_ACTIONS} actions.`;
  const problem = value.map(actionProblem).find((p) => p !== null);
  if (problem) return problem;
  const names = value.map((a) => str((a as { name?: unknown }).name).toLowerCase());
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  return twice ? `Two actions are called "${twice}". Give each its own name.` : null;
}

/** A list that passed `actionsProblem`, as stored; an action without an id gets one from `newId`. */
export function cleanActions(value: readonly unknown[], newId: () => string): SavedAction[] {
  return value.map((raw) => {
    const v = raw as Record<string, unknown>;
    const id = str(v.id);
    return { id: id && id.length <= 80 ? id : newId(), name: str(v.name), command: str(v.command), folder: str(v.folder).replace(/\/+$/, ''), previewUrl: str(v.previewUrl) };
  });
}

export function sanitizeActionsByProject(value: unknown): ActionsByProject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, SavedAction[]> = {};
  for (const [projectId, raw] of Object.entries(value)) {
    if (!Array.isArray(raw) || projectId.length === 0 || projectId.length > 200) continue;
    const kept = raw.filter((a) => actionProblem(a) === null && typeof (a as { id?: unknown }).id === 'string').slice(0, MAX_ACTIONS);
    if (kept.length > 0) out[projectId] = cleanActions(kept, () => '');
  }
  return out;
}

/** `all` with the project's actions replaced; a project left with none is dropped. */
export function withActions(all: ActionsByProject, projectId: string, actions: readonly SavedAction[]): ActionsByProject {
  const { [projectId]: _old, ...rest } = all;
  return actions.length > 0 ? { ...rest, [projectId]: actions } : rest;
}
