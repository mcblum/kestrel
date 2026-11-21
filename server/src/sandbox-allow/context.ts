// The folders a folder entry must stay clear of, read from the workspace as it stands: every
// registered project's folders, every session's worktree, and Kestrel's own data folder, each
// absolute with symlinks resolved (the same helper the project-edit rule resolves paths with).
import { homedir } from 'node:os';
import { resolveReal } from '../agents/claude/confine.ts';
import type { Workspace } from '../workspace.ts';
import type { FolderContext } from './validate.ts';

const real = (path: string): string => resolveReal(path, path);

export async function folderContext(workspace: Workspace, dataDir: string, home: string = homedir()): Promise<FolderContext> {
  const state = await workspace.state();
  return {
    home: real(home),
    dataDir: real(dataDir),
    projectFolders: state.projects.flatMap((p) => p.folders.map((f) => real(f.path))),
    worktrees: state.sessions.flatMap((s) => (s.worktreePath ? [real(s.worktreePath)] : [])),
  };
}
