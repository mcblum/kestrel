// The folders inside one parent folder, each with a checkbox, for adding several projects at once.
// A row shows the name the project will get, the path quietly beneath, and git or plain; one that
// cannot be added (already a project, not readable, inside a repository) is drawn disabled and says
// why. A folder the last batch could not add keeps its reason under it. Grey, like FolderList.
import type { ListedFolder } from '@kestrel/server/folder-batch';
import { canAdd, worktreeNote } from '@kestrel/server/folder-batch';
import { PathDetail } from './PathDetail.tsx';

type Props = {
  folders: readonly ListedFolder[];
  selected: readonly string[];
  onToggle: (path: string) => void;
  /** Reasons from the last batch, by path. */
  errors: Readonly<Record<string, string>>;
  busy?: boolean;
};

/** Why a folder cannot be ticked, in a few words; null when it can. */
function whyNot(folder: ListedFolder): string | null {
  if (folder.project) return `Already the project ${folder.project.name}`;
  if (!folder.readable) return 'Kestrel may not open this folder';
  return folder.problem;
}

function Row({ folder, checked, onToggle, error, busy }: { folder: ListedFolder; checked: boolean; onToggle: () => void; error?: string; busy?: boolean }) {
  const reason = whyNot(folder);
  const worktree = worktreeNote(folder);
  const renamed = folder.proposedName && folder.proposedName !== folder.name ? folder.proposedName : null;
  const id = `pick-${folder.path}`;
  return (
    <li className={`dir-row pick-row${reason ? ' unavailable' : ''}${error ? ' has-error' : ''}`}>
      <label className="dir-line" htmlFor={id}>
        <input id={id} type="checkbox" className="pick-check" checked={checked} disabled={busy || !canAdd(folder)} onChange={onToggle} />
        <span className="dir-text">
          <span className="dir-name">
            {folder.name}
            {renamed && <span className="pick-as">as {renamed}</span>}
          </span>
          {reason ? <small className="pick-why">{reason}</small> : <PathDetail path={folder.path} />}
          {/* A second checkout of a repository: said plainly, since it looks like any other git folder. */}
          {worktree && !reason && <small className="pick-why">{worktree}</small>}
        </span>
        <span className="dir-kind">{folder.readable ? (folder.worktreeOf ? 'worktree' : folder.isGit ? 'git' : 'plain') : ''}</span>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
    </li>
  );
}

export function FolderPickList({ folders, selected, onToggle, errors, busy }: Props) {
  const ticked = new Set(selected);
  return (
    <ul className="dir-list pick-list" aria-label="Folders">
      {folders.map((f) => (
        <Row key={f.path} folder={f} checked={ticked.has(f.path)} onToggle={() => onToggle(f.path)} error={errors[f.path]} busy={busy} />
      ))}
    </ul>
  );
}
