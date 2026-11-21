// What the hover card on a sidebar project row lists, as data: the session count line and one line
// per folder (the default marked when there are several). Pure; the card draws it.
import type { Project } from '../model.ts';
import { projectSessionIds, type HomeSession } from './pinned-homes.ts';
import { defaultFolder, NO_FOLDER_YET } from './project-folders.ts';

export interface CardFolder {
  id: string;
  path: string;
  /** Shown after the path: "· default" on the default of several, "· plain folder" when not git. */
  note: string;
}

export interface ProjectCardLines {
  /** "1 session", "3 sessions": every live session in the project, pinned ones included. */
  sessions: string;
  folders: CardFolder[];
  /** Shown in place of the folders when there are none. */
  noFolder: string | null;
}

export function projectCardLines(project: Pick<Project, 'id' | 'folders' | 'defaultFolderId'>, sessions: readonly HomeSession[]): ProjectCardLines {
  const count = projectSessionIds(sessions, project.id).length;
  const home = defaultFolder(project);
  const several = project.folders.length > 1;
  const folders = project.folders.map((f) => ({
    id: f.id,
    path: f.path,
    note: [several && f === home ? 'default' : '', f.isGit ? '' : 'plain folder'].filter(Boolean).map((n) => ` · ${n}`).join(''),
  }));
  return { sessions: `${count} session${count === 1 ? '' : 's'}`, folders, noFolder: folders.length === 0 ? NO_FOLDER_YET : null };
}
