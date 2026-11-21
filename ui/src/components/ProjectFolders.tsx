// The Folders section of a project's Settings tab: the heading with "Add folder" at its right, one
// line about the default, then the saved folders (add, remove, make one the default, drag to reorder;
// order means nothing else; Show in Finder or Copy path on each). A refusal shows beside its row.
import { SettingHeading } from './SettingHelp.tsx';
import { useState } from 'react';
import type { Project } from '@kestrel/server/model';
import { defaultFolder, placeFolder } from '@kestrel/server/project-folders';
import { runMenuAction } from '../commands.ts';
import { projectCalls } from '../projectActions.ts';
import { AddFolderInput } from './AddFolderInput.tsx';
import { FolderList } from './FolderList.tsx';

/** Show in Finder where the Mac app can; Copy path in a browser. */
const pathAction = () =>
  window.kestrelShell?.reveal
    ? { label: 'Show in Finder', run: (path: string) => void runMenuAction({ type: 'reveal', path }) }
    : { label: 'Copy path', run: (path: string) => void runMenuAction({ type: 'copy', text: path, what: 'path' }) };

export function ProjectFolders({ project, headingId }: { project: Project; headingId: string }) {
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // With no folder yet the add controls show at once; otherwise "Add folder" opens them.
  const [adding, setAdding] = useState(false);

  /** One change to the saved folders; its refusal goes beside `rowKey`. */
  const change = async (rowKey: string, call: () => ReturnType<typeof projectCalls.removeFolder>) => {
    setBusy(true);
    const result = await call();
    setBusy(false);
    setRowErrors(result.ok ? {} : { [rowKey]: result.error });
  };
  const add = async (path: string) => {
    const result = await projectCalls.addFolder(project.id, path);
    if (result.ok) setAdding(false);
    return result.ok ? null : result.error;
  };
  const rows = project.folders.map((f) => ({ key: f.id, path: f.path, isGit: f.isGit, ...(rowErrors[f.id] ? { error: rowErrors[f.id] } : {}) }));
  const showAdd = adding || rows.length === 0;

  return (
    <section className="project-dirs settings-block" aria-labelledby={headingId}>
      <div className="settings-block-head">
        <div><SettingHeading id={headingId} title="Folders" help={<p>New sessions start in the default folder. Add folders for this project, choose a default, or drag to reorder them.</p>} /></div>
        {rows.length > 0 && (
          <button type="button" className="link-button" aria-expanded={showAdd} onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Add folder'}
          </button>
        )}
      </div>
      <FolderList
        rows={rows}
        defaultKey={defaultFolder(project)?.id ?? null}
        onMakeDefault={(id) => void change(id, () => projectCalls.setDefaultFolder(project.id, id))}
        onRemove={(id) => void change(id, () => projectCalls.removeFolder(project.id, id))}
        onMove={(key, target, after) => void change(key, () => projectCalls.reorderFolders(project.id, placeFolder(project.folders.map((f) => f.id), key, target, after)))}
        busy={busy}
        pathAction={pathAction()}
      />
      {showAdd && <AddFolderInput onAdd={add} busy={busy} />}
    </section>
  );
}
