// A project's Settings tab → Git (server: shared/git-defaults.ts, git-defaults/api.ts): the base
// branch and the remote it is fetched from, chosen for the project, or left automatic. The choices
// come from the repository itself. Held once in the app store through useResource; a change writes
// back what the server stored.
import type { Project } from '@kestrel/server/model';
import { AUTOMATIC, DEFAULT_REMOTE, type GitChoices, type GitDefaults, type GitDefaultsByProject } from '@kestrel/server/git-defaults';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingRow } from './SettingRow.tsx';

const GIT_DEFAULTS_PATH = '/api/git-defaults';
type Answer = { defaults: GitDefaultsByProject };
const asDefaults = (raw: unknown): Sourced<GitDefaultsByProject> => ready((raw as Answer).defaults ?? {});
const asChoices = (raw: unknown): Sourced<GitChoices> => ready(raw as GitChoices);
const NO_CHOICES: GitChoices = { remotes: [], branches: [], automaticBranch: null };

/** A stored name the repository no longer lists still shows, so it can be seen and changed. */
const withStored = (list: readonly string[], stored: string): string[] => (stored && !list.includes(stored) ? [stored, ...list] : [...list]);

const BRANCH_HELP = (
  <p>
    The branch this project's work starts from and goes back to. New sessions that start "from the latest default branch" are cut from it, the New session box asks its question against it, and a new pull request targets it. Automatic follows the remote's own
    default branch, else main, else master. A branch chosen here that no longer exists is said in the session, which then starts from the checkout as it is.
  </p>
);
const REMOTE_HELP = <p>Where the base branch is fetched from before a session starts. Automatic is origin. Pull requests are still pushed to origin.</p>;

function Controls({ project, stored }: { project: Project; stored: GitDefaults }) {
  const remote = stored.remote || DEFAULT_REMOTE;
  const loaded = useResource(`${GIT_DEFAULTS_PATH}/choices?project=${encodeURIComponent(project.id)}&remote=${encodeURIComponent(remote)}`, asChoices).value;
  const choices = loaded.state === 'ready' ? loaded.value : NO_CHOICES;
  const save = async (next: GitDefaults) => {
    const answer = await act(() => call<Answer>(GIT_DEFAULTS_PATH, { method: 'PUT', body: JSON.stringify({ projectId: project.id, ...next }) }));
    if (answer) putResource(GIT_DEFAULTS_PATH, ready(answer.defaults));
  };
  const branchId = `git-defaults-${project.id}-branch`;
  const remoteId = `git-defaults-${project.id}-remote`;
  const missing = loaded.state === 'ready' && stored.baseBranch !== '' && !choices.branches.includes(stored.baseBranch);
  return (
    <>
      <SettingRow label="Base branch" htmlFor={branchId} help={BRANCH_HELP}>
        <select id={branchId} className="form-control" value={stored.baseBranch} onChange={(e) => void save({ ...stored, baseBranch: e.target.value })}>
          <option value="">Automatic{choices.automaticBranch ? ` (${choices.automaticBranch})` : ''}</option>
          {withStored(choices.branches, stored.baseBranch).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        {missing && <span className="delegation-limit-problem" role="alert">There is no {stored.baseBranch} on {remote} or in this checkout. It may not have been fetched yet.</span>}
      </SettingRow>
      <SettingRow label="Remote" htmlFor={remoteId} help={REMOTE_HELP}>
        <select id={remoteId} className="form-control" value={stored.remote} onChange={(e) => void save({ ...stored, remote: e.target.value })}>
          <option value="">Automatic ({DEFAULT_REMOTE})</option>
          {withStored(choices.remotes, stored.remote).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </SettingRow>
      {loaded.state === 'unavailable' && <p className="settings-help">{loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>}
    </>
  );
}

export function GitDefaultsSetting({ project }: { project: Project }) {
  const loaded = useResource(GIT_DEFAULTS_PATH, asDefaults).value;
  if (!project.folders.some((f) => f.isGit)) return <p className="settings-help">{project.name} has no git repository, so there is no branch or remote to choose.</p>;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return <Controls project={project} stored={loaded.value[project.id] ?? AUTOMATIC} />;
}
