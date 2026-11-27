// Which of the project's folders a new session starts in, beside the project picker and in its
// look. Drawn only when the project has more than one. It starts on the folder the project's
// newest session used (the default folder before any), so no choice needs storing.
import type { Controls } from '@kestrel/server/tabs';
import { folderName, folderOf, lastUsedFolder } from '@kestrel/server/project-folders';
import { useApp } from '../store.ts';
import { FolderChoice } from './FolderChoice.tsx';

/** The directory these controls start in: the one chosen, else the project's last used. Null with fewer than two. */
export function useChosenFolder(controls: Controls) {
  const project = useApp((s) => s.workspace?.projects.find((p) => p.id === controls.projectId));
  const sessions = useApp((s) => s.workspace?.sessions);
  if (!project || project.folders.length < 2) return { project, folder: null };
  return { project, folder: folderOf(project, controls.folderId) ?? lastUsedFolder(project, sessions ?? []) };
}

export function FolderPicker({ controls, onSelect }: { controls: Controls; onSelect: (folderId: string) => void }) {
  const { project, folder } = useChosenFolder(controls);
  if (!project || !folder) return null;
  return (
    <span className="ctl ctl-folder" title={`Folder: ${folderName(folder)}. Where the session works. The project's other folders stay readable.`}>
      <FolderChoice project={project} value={folder} onSelect={onSelect} />
    </span>
  );
}
