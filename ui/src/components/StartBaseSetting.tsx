// A project's Settings tab → General: "New sessions start from" (server: shared/start-base.ts,
// start-base/api.ts). The project's remembered answer to the New session box's question, or Ask each
// time. Git projects only. Held once in the app store through useResource; a change writes back what
// the server stored.
import type { Project } from '@kestrel/server/model';
import type { StartBasePrefs } from '@kestrel/server/start-base';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingRow } from './SettingRow.tsx';

const START_BASE_PATH = '/api/start-base';
type Answer = { prefs: StartBasePrefs };
const asPrefs = (raw: unknown): Sourced<StartBasePrefs> => ready((raw as Answer).prefs ?? {});
const ASK = 'ask';

const HELP = (
  <p>
    When this project's checkout is not on its default branch, starting a session asks whether its worktree starts from the latest default branch or from the branch checked out, as it is. Pick an answer here to stop being asked. Sessions an agent
    starts are never asked: they take the answer here, else the latest default branch.
  </p>
);

export function StartBaseSetting({ project }: { project: Project }) {
  const loaded = useResource(START_BASE_PATH, asPrefs).value;
  if (!project.folders.some((f) => f.isGit)) return null;
  const id = `start-base-${project.id}`;
  const change = async (value: string) => {
    const answer = await act(() => call<Answer>(START_BASE_PATH, { method: 'PUT', body: JSON.stringify({ projectId: project.id, choice: value === ASK ? null : value }) }));
    if (answer) putResource(START_BASE_PATH, ready(answer.prefs));
  };
  return (
    <SettingRow label="New sessions start from" htmlFor={id} help={HELP}>
      {loaded.state === 'ready' ? (
        <select id={id} className="form-control" value={loaded.value[project.id] ?? ASK} onChange={(e) => void change(e.target.value)}>
          <option value={ASK}>Ask each time</option>
          <option value="default">Latest default branch</option>
          <option value="current">Checked-out branch, as it is</option>
        </select>
      ) : (
        <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>
      )}
    </SettingRow>
  );
}
