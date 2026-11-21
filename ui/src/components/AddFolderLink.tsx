// "Add a directory": wherever a project with no directory has nothing to show (Changes, Files, Git),
// this goes to the project page's list of directories.
import { opener } from '../route.ts';
import { openProjectFolders } from '../projectNav.ts';

export function AddFolderLink({ projectId, label = 'Add a folder' }: { projectId: string; label?: string }) {
  return (
    <button type="button" className="link-button" {...opener((newTab) => openProjectFolders(projectId, newTab))}>
      {label}
    </button>
  );
}
