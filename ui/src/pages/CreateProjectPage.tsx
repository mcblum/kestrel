// Create project: a name and the project's folders, as a compact form on a page in the main canvas
// (styles/form-page.css). A project may start with no folder. The name follows the first folder
// until you type one. The default folder is chosen explicitly ("Make default"), the first until
// you do. Every refusal shows beside the field or row it is about. Folders dropped on the Dock icon
// land in the list too (openedFolders.ts), added to whatever is already typed.
// Its second way in, "Several from a folder" (`#/new-project/folder`), is ProjectsFromFolder.tsx.
import { useEffect, useRef, useState } from 'react';
import { CreateProjectTabs, createPanelId, createTabId, type CreateWay } from './CreateProjectTabs.tsx';
import { ProjectsFromFolder } from './ProjectsFromFolder.tsx';
import { folderName, placeFolder } from '@kestrel/server/project-folders';
import { AddFolderInput } from '../components/AddFolderInput.tsx';
import { FolderList, type FolderRow } from '../components/FolderList.tsx';
import { onOpenedFolders, takeOpenedFolders } from '../openedFolders.ts';
import { checkFolder, projectCalls } from '../projectActions.ts';
import { leaveCreateProject } from '../projectNav.ts';
import { openView } from '../route.ts';

type Errors = { name?: string; form?: string; dropped?: string; rows: Record<string, string> };
const NO_ERRORS: Errors = { rows: {} };
const NAME_NEEDED = 'Give the project a name.';

/** A folder as the list holds it before the project exists; the server checks it when added. */
async function rowFor(path: string, rows: readonly FolderRow[]): Promise<FolderRow | string> {
  const found = await checkFolder(path);
  if (!found.ok && !found.oldServer) return found.error;
  const row: FolderRow = found.ok ? { key: found.path, path: found.path, isGit: found.isGit } : { key: path, path, isGit: null };
  return rows.some((r) => r.key === row.key) ? `${row.path} is already in the list.` : row;
}

/** Where a refusal from Create belongs: the name, one of the rows, or the page. */
function placeError(error: string, field: string | undefined, rows: readonly FolderRow[]): Errors {
  if (field === 'name') return { ...NO_ERRORS, name: error };
  const row = rows.find((r) => r.path === field);
  return row ? { rows: { [row.key]: error } } : { ...NO_ERRORS, form: error };
}

/** The page: one heading, two ways in (one project, or several from a folder) as local tabs. */
export function CreateProjectPage({ from }: { from?: 'folder' }) {
  const way: CreateWay = from === 'folder' ? 'folder' : 'one';
  return (
    <div className="page column form-page create-project">
      <div className="form-head">
        <h1>Create project</h1>
        <p className="form-lede">{way === 'one' ? 'Organize sessions and the folders you work in.' : 'Add a project for each folder you pick, all at once.'}</p>
      </div>
      <CreateProjectTabs way={way} />
      {/* Both stay mounted, so what was typed or listed on one is there on coming back. */}
      <div role="tabpanel" id={createPanelId('one')} aria-labelledby={createTabId('one')} hidden={way !== 'one'} className="create-panel">
        <OneProjectForm />
      </div>
      <div role="tabpanel" id={createPanelId('folder')} aria-labelledby={createTabId('folder')} hidden={way !== 'folder'} className="create-panel">
        <ProjectsFromFolder />
      </div>
    </div>
  );
}

export function OneProjectForm({ onCreated, onCancel = leaveCreateProject, onBusyChange }: { onCreated?: () => void; onCancel?: () => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const [typedName, setTypedName] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly FolderRow[]>([]);
  const [chosenDefault, setChosenDefault] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  // The list as of the last add, so several folders added in a row are checked against each other.
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const name = typedName ?? (rows[0] ? folderName(rows[0]) : '');
  const defaultRow = rows.find((r) => r.key === chosenDefault) ?? rows[0] ?? null;

  const add = async (path: string): Promise<string | null> => {
    const row = await rowFor(path, latestRows.current);
    if (typeof row === 'string') return row;
    latestRows.current = [...latestRows.current, row];
    setRows((current) => [...current, row]);
    // The name follows the first folder until typed, so a missing-name error no longer applies.
    if (typedName === null) setErrors((x) => ({ ...x, name: undefined }));
    return null;
  };
  // Folders dropped on the Dock icon, now and while the page is open: added one after another; any
  // that cannot be added say why under the list.
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    const addDropped = async () => {
      const paths = takeOpenedFolders();
      if (paths.length === 0) return;
      const problems: string[] = [];
      for (const path of paths) {
        const problem = await addRef.current(path);
        if (problem) problems.push(problem);
      }
      setErrors((x) => ({ ...x, dropped: problems.length > 0 ? problems.join(' ') : undefined }));
    };
    void addDropped();
    return onOpenedFolders(() => void addDropped());
  }, []);

  const remove = (key: string) => {
    setRows((current) => current.filter((r) => r.key !== key));
    setErrors((e) => ({ ...e, rows: Object.fromEntries(Object.entries(e.rows).filter(([k]) => k !== key)) }));
  };
  const move = (key: string, target: string, after: boolean) =>
    setRows((current) => placeFolder(current.map((r) => r.key), key, target, after).map((k) => current.find((r) => r.key === k)!));

  const create = async () => {
    if (busy) return;
    if (!name.trim()) {
      setErrors({ ...NO_ERRORS, name: NAME_NEEDED });
      return nameField.current?.focus();
    }
    setBusy(true);
    onBusyChange?.(true);
    setErrors(NO_ERRORS);
    const result = await projectCalls.create(name.trim(), rows.map((r) => r.path), defaultRow?.path);
    setBusy(false);
    onBusyChange?.(false);
    if (!result.ok) return setErrors(placeError(result.error, result.field, rows));
    if (onCreated) return onCreated();
    if (result.project) openView({ kind: 'project', id: result.project.id });
  };

  return (
    <>
      <div className="form-field">
        <label htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          ref={nameField}
          autoFocus
          placeholder="e.g. Website redesign"
          value={name}
          disabled={busy}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? 'project-name-error' : undefined}
          onChange={(e) => (setTypedName(e.target.value), setErrors((x) => ({ ...x, name: undefined })))}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        {errors.name && <p id="project-name-error" className="field-error" role="alert">{errors.name}</p>}
      </div>
      <div className="form-field">
        <span className="form-label">
          Project folders<span className="form-optional">Optional</span>
        </span>
        <p className="form-note">Add folders to work with. You can add more later.</p>
        <FolderList rows={rows.map((r) => (errors.rows[r.key] ? { ...r, error: errors.rows[r.key] } : r))} defaultKey={defaultRow?.key ?? null} onMakeDefault={setChosenDefault} onRemove={remove} onMove={move} busy={busy} />
        <AddFolderInput onAdd={add} busy={busy} />
        {errors.dropped && <p className="field-error" role="alert">{errors.dropped}</p>}
      </div>
      {errors.form && <p className="field-error" role="alert">{errors.form}</p>}
      <div className="form-actions">
        <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary-button" disabled={busy} aria-busy={busy} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </>
  );
}
