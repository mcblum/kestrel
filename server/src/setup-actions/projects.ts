// Adding a folder a set-up step cloned to Kestrel (onboarding.md 18.2): a new project of that name, or a
// folder of the project that already has it, through the same functions a person adding a project uses.
// Undo takes back exactly that: the new project, or the folder added to an existing one.
import { addFolder, createProject, removeFolder } from '../project-store.ts';
import type { Workspace } from '../workspace.ts';

export function projectAdder(workspace: Workspace) {
  return async (name: string, path: string): Promise<{ said: string; undo(): Promise<void> }> => {
    const projects = (await workspace.state()).projects;
    if (projects.some((p) => p.folders.some((f) => f.path === path))) return { said: 'it was already in Kestrel.', undo: async () => undefined };
    const existing = projects.find((p) => p.name === name);
    if (existing) {
      const project = await addFolder(workspace, existing.id, path);
      const folder = project.folders.find((f) => f.path === path);
      return { said: `added it to ${name} in Kestrel.`, undo: async () => void (folder && (await removeFolder(workspace, existing.id, folder.id))) };
    }
    const project = await createProject(workspace, { name, folders: [path] });
    return { said: `added ${name} to Kestrel.`, undo: () => workspace.removeProject(project.id) };
  };
}
