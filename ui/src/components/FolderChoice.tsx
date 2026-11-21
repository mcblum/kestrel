// A choice among a project's folders, in the project picker's look: the composer's folder control
// and the folder switcher on a project page's Changes and Files panes. The default is marked.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProjectFolder } from '@kestrel/server/model';
import { defaultFolder, folderName, folderParent } from '@kestrel/server/project-folders';
import { PathDetail } from './PathDetail.tsx';
import { Popup } from './Popup.tsx';

type Props = { project: Pick<Project, 'folders' | 'defaultFolderId'>; value: ProjectFolder; onSelect: (folderId: string) => void; label?: string };

/** Close a popover on a click outside it or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, close]);
  return host;
}

export function FolderChoice({ project, value, onSelect, label = 'Folder' }: Props) {
  const home = defaultFolder(project);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const host = useDismiss(open, close);
  const button = useRef<HTMLButtonElement>(null);
  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
  };
  return (
    <div className="picker" ref={host}>
      <button ref={button} type="button" className="picker-button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <span className="picker-value">{folderName(value)}</span>
      </button>
      {open && (
        <Popup anchor={button} className="picker-pop" role="dialog" aria-label="Choose a folder">
          <div className="picker-list" role="listbox">
            {project.folders.map((f) => (
              <button type="button" role="option" aria-selected={f.id === value.id} key={f.id} className={`picker-row${f.id === value.id ? ' selected' : ''}`} onClick={() => choose(f.id)}>
                <span className="picker-mark">{folderName(f).charAt(0).toUpperCase()}</span>
                <span className="picker-text">
                  <strong>{folderName(f)}</strong>
                  <PathDetail path={folderParent(f)} note={`${f === home ? ' · default' : ''}${f.isGit ? '' : ' · plain folder'}`} />
                </span>
              </button>
            ))}
          </div>
        </Popup>
      )}
    </div>
  );
}
