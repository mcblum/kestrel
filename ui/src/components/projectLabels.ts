// How a project is described where one line has to do: the sidebar row's tooltip, the path its menu
// reveals or copies. A project with several directories is described by its default one.
import type { Project } from '@kestrel/server/model';
import { defaultFolder, NO_FOLDER_YET } from '@kestrel/server/project-folders';

/** The default directory's path, for Show in Finder and Copy path; undefined when it has none. */
export const projectPathOf = (project: Project | undefined): string | undefined => (project ? (defaultFolder(project)?.path ?? undefined) : undefined);

export function projectTooltip(project: Project): string {
  const first = defaultFolder(project);
  if (!first) return `${project.name} · ${NO_FOLDER_YET}`;
  if (project.folders.length > 1) return `${project.name} · ${first.path} and ${project.folders.length - 1} more`;
  return `${project.name} · ${first.path}${first.isGit ? '' : ' · plain folder, no git'}`;
}
