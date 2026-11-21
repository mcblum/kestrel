// A project's Settings tab → Actions (server: shared/saved-actions.ts, saved-actions/api.ts): the
// project's named commands, edited as rows and saved together. Held once in the app store through
// useResource; Save writes back what the server stored.
import { useDraft } from '../unsaved.ts';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Project } from '@kestrel/server/model';
import { actionsProblem, MAX_ACTIONS, type SavedAction } from '@kestrel/server/saved-actions';
import { ready } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { asSavedActions, SAVED_ACTIONS_PATH, type SavedActionsAnswer } from './TerminalActions.tsx';

/** A row being edited; one not saved yet has no id. */
type Row = Omit<SavedAction, 'id'> & { id?: string; key: string };
let nextKey = 0;
const rowOf = (action: SavedAction): Row => ({ ...action, key: action.id });
const BLANK = (): Row => ({ key: `new-${nextKey++}`, name: '', command: '', folder: '', previewUrl: '' });
const sent = (rows: readonly Row[]) => rows.map(({ key: _key, ...action }) => action);
const NONE: readonly SavedAction[] = [];

const FIELDS: { key: 'name' | 'command' | 'folder' | 'previewUrl'; label: string; placeholder: string; mono?: boolean }[] = [
  { key: 'name', label: 'Name', placeholder: 'Dev server' },
  { key: 'command', label: 'Command', placeholder: 'pnpm dev', mono: true },
  { key: 'folder', label: 'Folder', placeholder: 'the working folder', mono: true },
  { key: 'previewUrl', label: 'Preview address', placeholder: 'none', mono: true },
];

function Editor({ projectId, stored }: { projectId: string; stored: readonly SavedAction[] }) {
  const [rows, setRows] = useState<Row[]>(() => stored.map(rowOf));
  useEffect(() => setRows(stored.map(rowOf)), [stored]);
  const change = (key: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const problem = actionsProblem(sent(rows));
  const changed = JSON.stringify(sent(rows)) !== JSON.stringify(stored);
  const save = async () => {
    const answer = await act(() => call<SavedActionsAnswer>(SAVED_ACTIONS_PATH, { method: 'PUT', body: JSON.stringify({ projectId, actions: sent(rows) }) }));
    if (answer) putResource(SAVED_ACTIONS_PATH, ready(answer.actions));
    return Boolean(answer);
  };
  const anchor = useDraft({ what: 'Actions', changed, problem, save, discard: () => setRows(stored.map(rowOf)) });
  return (
    <>
      {rows.length === 0 && <p className="settings-help">No actions yet.</p>}
      <ul className="saved-actions">
        {rows.map((row, i) => (
          <li key={row.key} className="saved-action">
            {FIELDS.map(({ key, label, placeholder, mono }) => {
              const id = `saved-action-${projectId}-${row.key}-${key}`;
              return (
                <label key={key} htmlFor={id} className={`saved-action-field ${key}`}>
                  <span>{label}</span>
                  <input id={id} className={`form-control${mono ? ' mono' : ''}`} spellCheck={false} placeholder={placeholder} value={row[key]} onChange={(e) => change(row.key, { [key]: e.target.value })} />
                </label>
              );
            })}
            <button type="button" className="icon-button saved-action-remove" aria-label={`Remove ${row.name || `action ${i + 1}`}`} title="Remove" onClick={() => setRows(rows.filter((r) => r.key !== row.key))}>
              <Trash2 aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {changed && problem && <span className="delegation-limit-problem" role="alert">{problem}</span>}
      <div className="delegation-limits-actions">
        <button type="button" disabled={rows.length >= MAX_ACTIONS} onClick={() => setRows([...rows, BLANK()])}>
          <Plus aria-hidden /> Add action
        </button>
      </div>
      <span ref={anchor} className="draft-anchor" />
    </>
  );
}

export function SavedActionsSetting({ project }: { project: Project }) {
  const loaded = useResource(SAVED_ACTIONS_PATH, asSavedActions).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return <Editor projectId={project.id} stored={loaded.value[project.id] ?? NONE} />;
}
