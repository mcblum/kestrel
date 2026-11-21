// A project's Settings tab → Scripts (server: shared/project-scripts.ts, project-scripts/api.ts):
// the setup script a new session's worktree runs before its agent starts, and the archive script
// it runs before the session is archived. Held once in the app store through useResource; Save
// writes back what the server stored.
import { useDraft } from '../unsaved.ts';
import { useEffect, useState, type ReactNode } from 'react';
import type { Project } from '@kestrel/server/model';
import { NO_SCRIPTS, scriptProblem, type ProjectScripts, type ScriptKind, type ScriptsByProject } from '@kestrel/server/project-scripts';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingRow } from './SettingRow.tsx';

const PROJECT_SCRIPTS_PATH = '/api/project-scripts';
type Answer = { scripts: ScriptsByProject };
const asScripts = (raw: unknown): Sourced<ScriptsByProject> => ready((raw as Answer).scripts ?? {});

const VARIABLES = (
  <p>
    It runs in your login shell, in the session's worktree, and can read <code>KESTREL_ROOT_PATH</code> (this project's own folder), <code>KESTREL_WORKTREE_PATH</code>, <code>KESTREL_BRANCH</code>, <code>KESTREL_PROJECT_NAME</code> and{' '}
    <code>KESTREL_SESSION_ID</code>.
  </p>
);

const FIELDS: { kind: ScriptKind; label: string; placeholder: string; help: ReactNode }[] = [
  {
    kind: 'setup',
    label: 'Setup script',
    placeholder: 'pnpm install\ncp "$KESTREL_ROOT_PATH/.env" .env',
    help: (
      <>
        <p>Runs once in each new session's worktree, before its agent starts: install dependencies, copy local files, prepare services. It shows in the conversation as a step with its output, and in the Commands pane.</p>
        <p>If it fails, the agent is not started and the session says why; a reply runs it again in the same worktree. Stopping the session stops the script. It is ended after 15 minutes.</p>
        {VARIABLES}
      </>
    ),
  },
  {
    kind: 'archive',
    label: 'Archive script',
    placeholder: 'docker compose down',
    help: (
      <>
        <p>Runs in a session's worktree when you archive that session, before it is archived: stop services, free ports. If it fails, the session is not archived and you are shown its output, with the choice to archive anyway. It is ended after 2 minutes.</p>
        <p>It does not run when a whole project or group is archived, or for a session whose worktree is gone.</p>
        {VARIABLES}
      </>
    ),
  },
];

function Editor({ projectId, stored }: { projectId: string; stored: ProjectScripts }) {
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const problems = { setup: scriptProblem(draft.setup), archive: scriptProblem(draft.archive) };
  const changed = draft.setup !== stored.setup || draft.archive !== stored.archive;
  const save = async () => {
    const answer = await act(() => call<Answer>(PROJECT_SCRIPTS_PATH, { method: 'PUT', body: JSON.stringify({ projectId, ...draft }) }));
    if (answer) putResource(PROJECT_SCRIPTS_PATH, ready(answer.scripts));
    return Boolean(answer);
  };
  const anchor = useDraft({ what: 'Scripts', changed, problem: problems.setup ?? problems.archive, save, discard: () => setDraft(stored) });
  return (
    <>
      {FIELDS.map(({ kind, label, placeholder, help }) => {
        const id = `project-script-${projectId}-${kind}`;
        return (
          <SettingRow key={kind} label={label} htmlFor={id} help={help} stacked>
            <textarea id={id} className="form-control project-script" rows={5} spellCheck={false} placeholder={placeholder} value={draft[kind]} aria-invalid={problems[kind] !== null} onChange={(e) => setDraft({ ...draft, [kind]: e.target.value })} />
            {problems[kind] && <span className="delegation-limit-problem">{problems[kind]}</span>}
          </SettingRow>
        );
      })}
<span ref={anchor} className="draft-anchor" />
    </>
  );
}

export function ProjectScriptsSetting({ project }: { project: Project }) {
  const loaded = useResource(PROJECT_SCRIPTS_PATH, asScripts).value;
  if (!project.folders.some((f) => f.isGit)) return <p className="settings-help">Scripts run in a session's worktree. {project.name} has no git repository, so its sessions work in the folder itself and nothing is run.</p>;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return <Editor projectId={project.id} stored={loaded.value[project.id] ?? NO_SCRIPTS} />;
}
