// The one quiet line under a project's title, on both its local tabs: its default folder (with ~, cut
// in the middle when long), then the folder count ("1 folder", "No folder yet") as a quiet link to the
// Settings tab's Folders section.
import type { Project } from '@kestrel/server/model';
import { folderSummary } from '@kestrel/server/project-folders';
import { PathDetail } from '../components/PathDetail.tsx';
import { opener } from '../route.ts';
import { openProjectFolders } from '../projectNav.ts';

export function ProjectFolderLine({ project }: { project: Project }) {
  const { path, count } = folderSummary(project);
  return (
    <>
      {path && <PathDetail path={path} note=" · " />}
      <button type="button" className="link-button quiet-link" title="Folders, in this project's settings" {...opener((newTab) => openProjectFolders(project.id, newTab))}>
        {count}
      </button>
    </>
  );
}
