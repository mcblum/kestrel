// A project's name on its Settings tab: a field whose typing is a draft (unsaved.ts), saved or
// discarded by the screen's one Save bar like every other typed setting; Return saves too. A
// refusal from the server (empty, or another project's name) shows under the field. A rename made
// elsewhere (the … menu, the sidebar row) shows here unless the field has unsaved typing.
import { useEffect, useState } from 'react';
import { SettingRow } from './SettingRow.tsx';
import { projectCalls } from '../projectActions.ts';
import { useDraft } from '../unsaved.ts';

export function ProjectNameField({ projectId, name }: { projectId: string; name: string }) {
  const [typed, setTyped] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState(name);

  // Renamed elsewhere: follow it, unless the user is in the middle of typing another name.
  useEffect(() => {
    setTyped((t) => (t === known ? name : t));
    setKnown(name);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = typed.trim() !== name;
  const save = async (): Promise<boolean> => {
    if (!changed) return true;
    const result = await projectCalls.rename(projectId, typed);
    setError(result.ok ? null : result.error);
    if (result.ok) setTyped(typed.trim());
    return result.ok;
  };
  // The server says why a name is refused, after a try; until then nothing stops the Save bar.
  const anchor = useDraft({ what: 'Project name', changed, problem: null, save, discard: () => (setTyped(name), setError(null)) });

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
          onChange={(e) => (setTyped(e.target.value), setError(null))}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())}
        />
      </div>
      <span ref={anchor} className="draft-anchor" />
      {error && (
        <p className="field-error" id={`project-name-${projectId}-error`} role="alert">
          {error}
        </p>
      )}
    </SettingRow>
  );
}
