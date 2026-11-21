// Keeping each project's edits in its own session (Settings → Workflow, on by default; Matt,
// 2026-11-18). A session may edit files in its own project and files that are in no project at
// all. A file inside ANOTHER registered project is refused, with the reason and what to do
// instead: delegate, so a session of that project makes the change in its own worktree and this
// one reports back. Pure: the runtime resolves the path and asks; adapters hand the answer to the
// agent. Shell commands cannot be checked this way (a child's are held by its sandbox).

export interface ProjectEditPrefs {
  /** Refuse an edit to a file in another registered project. */
  keepInProject: boolean;
}

export const DEFAULT_PROJECT_EDIT_PREFS: ProjectEditPrefs = { keepInProject: true };

/** Stored or sent prefs made safe: anything that is not exactly `false` leaves the rule on. */
export function sanitizeProjectEditPrefs(value: unknown): ProjectEditPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { keepInProject: v.keepInProject !== false };
}

export interface EditableProject {
  id: string;
  name: string;
  folders: readonly { path: string }[];
}

export const within = (path: string, folder: string): boolean => {
  const root = folder.endsWith('/') ? folder : `${folder}/`;
  return path === folder || path.startsWith(root);
};

/**
 * The registered project, other than the session's own, that holds `path`; null when the file is
 * in the session's own project or in no project. `path` and the folders are absolute and resolved
 * by the caller. When folders nest, the innermost one decides.
 */
export function otherProjectHolding(path: string, projects: readonly EditableProject[], ownProjectId: string | null): EditableProject | null {
  let best: { project: EditableProject; length: number } | null = null;
  for (const project of projects) for (const folder of project.folders) if (within(path, folder.path) && (!best || folder.path.length > best.length)) best = { project, length: folder.path.length };
  return best && best.project.id !== ownProjectId ? best.project : null;
}

/** What the agent is told when its edit is refused: why, and what to do instead. */
export function otherProjectRefusal(path: string, projectName: string, delegateTool: string): string {
  return `${path} is in the Kestrel project "${projectName}", and a session does not edit another project's files from where it is. Call ${delegateTool} with a brief for "${projectName}": a session there makes the change in its own worktree, you are told when it finishes, and you tell the user the outcome here. (The user can turn this rule off in Settings → Workflow.)`;
}

export interface WorktreeOwner {
  id: string;
  title: string;
  worktreePath: string | null;
}

/**
 * The session, other than the one asking, whose worktree holds `path`; null when the file is in
 * no other session's worktree. A worktree belongs to the session Kestrel made it for: only that
 * session's agent changes it (Matt, 2026-11-18). Paths are absolute and resolved by the caller.
 */
export function otherWorktreeHolding<T extends WorktreeOwner>(path: string, sessions: readonly T[], ownSessionId: string): T | null {
  return sessions.find((s) => s.id !== ownSessionId && s.worktreePath !== null && within(path, s.worktreePath)) ?? null;
}

/** What the agent is told when it tries to edit another session's worktree: why, and how to get the change made. */
export function otherWorktreeRefusal(path: string, owner: Pick<WorktreeOwner, 'id' | 'title'>, askTool: string): string {
  return `${path} is in the worktree of the session "${owner.title}" (${owner.id}). Only that session changes its own worktree. Call ${askTool} with session "${owner.id}" and a message saying exactly what to change: its agent makes the change there, and you are told when it finishes. (The user can turn this rule off in Settings → Workflow.)`;
}
