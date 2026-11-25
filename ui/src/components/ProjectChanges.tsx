// A project page's Changes: what the main checkout has that HEAD does not, uncommitted edits and
// new files, shown like a session's changes. Read only. Asked for again when the window comes
// back into focus and every few seconds while the column is open. Held once in the app store
// (data/resources.ts), so every view of it shows the same answer, and it changes only when it did.
import { useEffect, useState } from 'react';
import type { ProjectChanges as Answer } from '@kestrel/server/model';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { useApp } from '../store.ts';
import { ChangesView } from './Changes.tsx';
import { defaultFolder, folderOf, NO_FOLDER_YET } from '@kestrel/server/project-folders';
import { AddFolderLink } from './AddFolderLink.tsx';
import { FolderSwitch } from './FolderSwitch.tsx';

const REFRESH_MS = 5000;

const asChanges = (raw: unknown): Sourced<Answer> => ready(raw as Answer);

/** The project's changes from the store, asked for again while shown; null until the first answer. */
export function useProjectChanges(projectId: string, refreshMs = REFRESH_MS, folderId: string | null = null): { changes: Answer | null; error: string | null } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((t) => t + 1);
    const timer = refreshMs > 0 ? setInterval(again, refreshMs) : undefined;
    window.addEventListener('focus', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
    };
  }, [refreshMs]);
  const path = `/api/projects/${encodeURIComponent(projectId)}/changes${folderId ? `?folder=${encodeURIComponent(folderId)}` : ''}`;
  const answer = useResource(path, asChanges, String(tick)).value;
  if (answer.state === 'ready') return { changes: answer.value, error: null };
  return { changes: null, error: answer.state === 'unavailable' ? answer.reason || 'Could not read the changes.' : null };
}

export function ProjectChanges({ projectId }: { projectId: string }) {
  const project = useApp((s) => s.workspace?.projects.find((p) => p.id === projectId));
  const [folderId, setFolderId] = useState<string | null>(null);
  const folder = project ? (folderOf(project, folderId) ?? defaultFolder(project)) : null;
  const { changes, error } = useProjectChanges(projectId, REFRESH_MS, folder?.id ?? null);
  const switcher = project && folder && <FolderSwitch project={project} folder={folder} onSelect={setFolderId} />;
  return (
    <div className="changes-pane">
      {switcher}
      <ChangesBody projectId={projectId} changes={changes} error={error} noFolder={project !== undefined && !folder} />
    </div>
  );
}

function ChangesBody({ projectId, changes, error, noFolder }: { projectId: string; changes: Answer | null; error: string | null; noFolder: boolean }) {
  if (noFolder) return <div className="context-content"><h3>{NO_FOLDER_YET}</h3><p>This project has no folder to compare. <AddFolderLink projectId={projectId} /></p></div>;
  if (error) return <div className="context-content"><p>{error}</p></div>;
  if (!changes) return <div className="context-content"><p className="muted">Loading…</p></div>;
  if (changes.note) return <div className="context-content"><h3>{changes.note}</h3>{!changes.isGit && <p>This project is a plain folder, so there is no change history to compare against.</p>}</div>;
  const empty = (
    <>
      <h3>No uncommitted changes</h3>
      <p>Nothing in this folder differs from {changes.branch ? `the tip of ${changes.branch}` : 'HEAD'}.</p>
    </>
  );
  return <ChangesView files={changes.files} resetKey={projectId} empty={empty} against="HEAD" />;
}
