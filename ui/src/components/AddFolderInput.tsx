// Adding a folder. In the Mac app: one "Choose folder…" button (the native chooser, again for each
// more), and "Enter path manually" beside it, which reveals a path field with its own Add button. In
// the browser build there is no chooser, so the path field shows at once and nothing is drawn that
// would do nothing. `onAdd` answers with an error to show here, or null once the folder is added.
import { useState } from 'react';

type Props = {
  onAdd: (path: string) => Promise<string | null>;
  busy?: boolean;
  /** The path field's button ("Add"; "Show folders" when choosing a parent folder). */
  submitLabel?: string;
  placeholder?: string;
};

export function AddFolderInput({ onAdd, busy, submitLabel = 'Add', placeholder = 'Full path, e.g. ~/Code/website' }: Props) {
  const canPick = Boolean(window.kestrelShell?.pickFolder);
  const [manual, setManual] = useState(!canPick);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const add = async (path: string) => {
    setWorking(true);
    const problem = await onAdd(path.trim());
    setWorking(false);
    setError(problem);
    return problem === null;
  };
  const pick = async () => {
    const picked = await window.kestrelShell?.pickFolder();
    if (picked) await add(picked);
  };
  const submitTyped = async () => {
    if (!typed.trim()) return;
    if (await add(typed)) setTyped('');
  };
  const disabled = busy || working;

  return (
    <div className="dir-add">
      {canPick && (
        <div className="dir-add-row">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void pick()}>
            Choose folder…
          </button>
          {!manual && (
            <button type="button" className="quiet-button" disabled={disabled} onClick={() => setManual(true)}>
              Enter path manually
            </button>
          )}
        </div>
      )}
      {manual && (
        <div className="dir-add-row">
          <input
            className="form-control dir-path"
            aria-label="Folder path"
            placeholder={placeholder}
            value={typed}
            autoFocus={canPick}
            disabled={disabled}
            onChange={(e) => (setTyped(e.target.value), setError(null))}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void submitTyped())}
          />
          <button type="button" className="secondary-button" disabled={disabled || !typed.trim()} onClick={() => void submitTyped()}>
            {submitLabel}
          </button>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
