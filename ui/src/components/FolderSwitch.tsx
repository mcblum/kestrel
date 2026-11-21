// Above a project page's Changes and Files: which of the project's folders the pane shows. With
// several, a choice in the picker's look; with one, nothing is drawn (there is nothing to choose).
import type { Project, ProjectFolder } from '@kestrel/server/model';
import { FolderChoice } from './FolderChoice.tsx';

export function FolderSwitch({ project, folder, onSelect }: { project: Project; folder: ProjectFolder; onSelect: (folderId: string) => void }) {
  if (project.folders.length < 2) return null;
  return (
    <div className="folder-switch">
      <span className="form-note">Showing</span>
      <FolderChoice project={project} value={folder} onSelect={onSelect} />
    </div>
  );
}
