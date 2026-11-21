// A project's name on its Settings tab: a field and Save (enabled once the name changed; Return saves
// too). A refusal from the server (empty, or another project's name) shows under the field; a saved
// name says so briefly. A rename made elsewhere (the … menu, the sidebar row) shows here unless the
// field has unsaved typing.
import { useEffect, useState } from 'react';
import { SettingRow } from './SettingRow.tsx';
import { projectCalls } from '../projectActions.ts';

/** How long "Saved" stays beside the button: a display detail, nothing waits on it. */
const SAVED_FOR_MS = 2000;

export function ProjectNameField({ projectId, name }: { projectId: string; name: string }) {
  const [typed, setTyped] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [known, setKnown] = useState(name);

  // Renamed elsewhere: follow it, unless the user is in the middle of typing another name.
  useEffect(() => {
    setTyped((t) => (t === known ? name : t));
    setKnown(name);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const changed = typed.trim() !== name;
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    const result = await projectCalls.rename(projectId, typed);
    setSaving(false);
    setError(result.ok ? null : result.error);
    if (result.ok) {
      setTyped(typed.trim());
      setSaved(true);
    }
  };

  return (
    <SettingRow label="Project name" htmlFor={`project-name-${projectId}`}>
      <div className="name-row">
        <input
          id={`project-name-${projectId}`}
          className="form-control"
          value={typed}
          maxLength={80}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `project-name-${projectId}-error` : undefined}
          onChange={(e) => (setTyped(e.target.value), setError(null), setSaved(false))}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())}
        />
        <button type="button" className="secondary-button" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && (
          <span className="name-saved" role="status">
            Saved
          </span>
        )}
      </div>
      {error && (
        <p className="field-error" id={`project-name-${projectId}-error`} role="alert">
          {error}
        </p>
      )}
    </SettingRow>
  );
}
