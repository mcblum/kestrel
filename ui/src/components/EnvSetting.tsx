// The environment settings (server: shared/project-env.ts, project-env/api.ts), for one project
// (its Settings tab → Environment) or for every project (Settings → Environment):
// variables, .env files to read, and untracked files to copy into each new worktree. Held once in
// the app store through useResource; Save writes back what the server stored.
import { useDraft } from '../unsaved.ts';
import { useEffect, useState, type ReactNode } from 'react';
import { envProblem, GLOBAL_ENV, listText, NO_ENV, textList, type EnvByScope, type EnvSettings } from '@kestrel/server/project-env';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingRow } from './SettingRow.tsx';
import { SettingSection } from './SettingHelp.tsx';

const PROJECT_ENV_PATH = '/api/project-env';
type Answer = { env: EnvByScope };
const asEnv = (raw: unknown): Sourced<EnvByScope> => ready((raw as Answer).env ?? {});

/** What is being typed: the lists as text, one per line. */
interface Draft {
  vars: string;
  files: string;
  copy: string;
}
const draftOf = (env: EnvSettings): Draft => ({ vars: env.vars, files: listText(env.files), copy: listText(env.copy) });
const settingsOf = (draft: Draft): EnvSettings => ({ vars: draft.vars, files: textList(draft.files), copy: textList(draft.copy) });

const fields = (everyProject: boolean): { key: keyof Draft; label: string; placeholder: string; rows: number; help: ReactNode }[] => [
  {
    key: 'vars',
    label: 'Variables',
    placeholder: 'API_URL=http://localhost:3000\nLOG_LEVEL=debug',
    rows: 4,
    help: (
      <>
        <p>One NAME=value per line. They are added to each session's agent, so the commands it runs see them, and to the project's setup and archive scripts.{everyProject ? ' A project\'s own variable of the same name wins.' : ' They win over the app-wide ones in Settings → Environment.'}</p>
        <p>These are stored as typed in Kestrel's own data. Keep a secret in a .env file and list that file below instead.</p>
      </>
    ),
  },
  {
    key: 'files',
    label: '.env files',
    placeholder: everyProject ? '~/.config/dev.env' : '.env\n~/.config/dev.env',
    rows: 2,
    help: <p>One path per line: absolute, starting with ~/, or relative to {everyProject ? 'each project\'s' : 'the project\'s'} folder. Each is read when a session's agent starts, so a change is picked up by the next session; only the path is stored. A variable typed above wins over one from a file. A file that cannot be read is named in the session and the rest still applies.</p>,
  },
  {
    key: 'copy',
    label: 'Files to copy into new worktrees',
    placeholder: '.env.local\nconfig/*.local.json',
    rows: 3,
    help: (
      <p>
        One pattern per line, relative to {everyProject ? 'each project\'s' : 'the project\'s'} folder, as git reads them (<code>*</code> stays in one folder, <code>**</code> crosses folders). When a session's worktree is made, matching files that git does not track
        (ignored ones such as <code>.env</code>) are copied in before the setup script runs. A file the worktree already has is left alone, and at most 500 files are copied.
      </p>
    ),
  },
];

function Editor({ scope, stored }: { scope: string; stored: EnvSettings }) {
  const [draft, setDraft] = useState(() => draftOf(stored));
  useEffect(() => setDraft(draftOf(stored)), [stored]);
  const next = settingsOf(draft);
  const problem = envProblem(next);
  const changed = JSON.stringify(next) !== JSON.stringify(stored);
  const save = async () => {
    const answer = await act(() => call<Answer>(PROJECT_ENV_PATH, { method: 'PUT', body: JSON.stringify({ scope, ...next }) }));
    if (answer) putResource(PROJECT_ENV_PATH, ready(answer.env));
    return Boolean(answer);
  };
  const anchor = useDraft({ what: 'Environment', changed, problem, save, discard: () => setDraft(draftOf(stored)) });
  return (
    <>
      {fields(scope === GLOBAL_ENV).map(({ key, label, placeholder, rows, help }) => {
        const id = `project-env-${scope}-${key}`;
        return (
          <SettingRow key={key} label={label} htmlFor={id} help={help} stacked>
            <textarea id={id} className="form-control project-script" rows={rows} spellCheck={false} placeholder={placeholder} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </SettingRow>
        );
      })}
      {problem && <span className="delegation-limit-problem" role="alert">{problem}</span>}
      <span ref={anchor} className="draft-anchor" />
    </>
  );
}

/** `scope`: a project's id, or GLOBAL_ENV for what every project gets. */
export function EnvSetting({ scope }: { scope: string }) {
  const loaded = useResource(PROJECT_ENV_PATH, asEnv).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return <Editor scope={scope} stored={loaded.value[scope] ?? NO_ENV} />;
}

/** Settings → Environment: what every project's sessions get. */
export function GlobalEnvSetting({ page = false }: { page?: boolean } = {}) {
  return (
    <SettingSection level={page ? 1 : 2} className={page ? "settings-section settings-page-section" : "settings-section"} title="Environment" help={<p className="settings-help">Variables, .env files and copied files for the sessions of every project. A project adds its own on its Settings tab under Environment.</p>}>
      <EnvSetting scope={GLOBAL_ENV} />
    </SettingSection>
  );
}
