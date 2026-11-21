// The directory a session works in, as the UI knows it: the server resolves it (`folderId`); an
// older server sends none, and then it is the project's default directory.
import type { Project, ProjectFolder, SessionView } from '@kestrel/server/model';
import { defaultFolder, folderOf } from '@kestrel/server/project-folders';

export function sessionFolder(session: Pick<SessionView, 'folderId'>, project: Project | undefined): ProjectFolder | null {
  if (!project) return null;
  return session.folderId === undefined ? defaultFolder(project) : folderOf(project, session.folderId);
}
