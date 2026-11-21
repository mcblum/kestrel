// Settings → Workflow: "Keep each project's edits in its own session" (server:
// shared/project-edits.ts, project-edits/api.ts). On by default. Held once in the app store, like
// the tag suggestion prefs; a change writes back what the server stored.
import { SettingSection } from './SettingHelp.tsx';
import type { ProjectEditPrefs } from '@kestrel/server/project-edits';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

export const PROJECT_EDITS_PATH = '/api/project-edits';
const asPrefs = (raw: unknown): Sourced<ProjectEditPrefs> => ready(raw as ProjectEditPrefs);

function ProjectEditsSettingControls() {
  const loaded = useResource(PROJECT_EDITS_PATH, asPrefs).value;
  const change = async (keepInProject: boolean) => {
    const prefs = await act(() => call<ProjectEditPrefs>(PROJECT_EDITS_PATH, { method: 'PATCH', body: JSON.stringify({ keepInProject }) }));
    if (prefs) putResource(PROJECT_EDITS_PATH, ready(prefs));
  };
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={loaded.value.keepInProject} onChange={(e) => void change(e.target.checked)} />
        Keep each project's edits in its own session
      </label>
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      When a session needs to change a file that is in another project, the edit is refused and the agent is told to delegate: a session of that project makes the change in its own worktree and reports back in the chat you asked in. A file in another
      session's worktree is refused the same way, and the agent asks that session to make the change. Files that are in no project (a settings file, a config file elsewhere on this Mac) the session edits itself. Shell commands are not covered. Turn this
      off to let a session edit those files directly, under its approval mode.
    </p>
  </>
);

export function ProjectEditsSetting() {
  return (
    <SettingSection title="Where changes are made" help={HELP}>
      <ProjectEditsSettingControls />
    </SettingSection>
  );
}
