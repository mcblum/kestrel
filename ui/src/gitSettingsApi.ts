// Settings → Git (server: git-settings/api.ts): the branch name prefix new sessions' branches get,
// whether new sessions start from the latest base branch, and the account the "Your username" choice uses (gh's GitHub login, else glab's GitLab username).
import type { BranchPrefixSetting } from '@kestrel/server/branch-prefix';
import { call } from './store.ts';

/** A username and where it is from ("GitHub", a GitLab host), or why there is none. */
export type AccountLogin = { available: true; login: string; service: string } | { available: false; reason: string };

export interface GitSettingsView {
  branchPrefix: BranchPrefixSetting;
  /** Fetch the base branch and cut a new session's worktree from its newest commit (on by default). */
  startFromLatest: boolean;
  username: AccountLogin;
}

export const GIT_SETTINGS_PATH = '/api/git-settings';
const PATH = GIT_SETTINGS_PATH;

/** Save the branch prefix; throws with the server's reason when it is refused. */
export const saveBranchPrefix = (branchPrefix: BranchPrefixSetting): Promise<GitSettingsView> => call<GitSettingsView>(PATH, { method: 'PATCH', body: JSON.stringify({ branchPrefix }) });

/** Turn "Start new sessions from the latest base branch" on or off; throws with the server's reason when it is refused. */
export const saveStartFromLatest = (startFromLatest: boolean): Promise<GitSettingsView> => call<GitSettingsView>(PATH, { method: 'PATCH', body: JSON.stringify({ startFromLatest }) });
