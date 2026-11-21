// "Your username" for the branch name prefix: the GitHub login when gh has one, else the GitLab
// username from glab, else no username with both reasons. Each source keeps its own answer for the
// server's lifetime, so asking again costs nothing.
import type { AccountLogin } from './github-login.ts';

export type UsernameSource = () => Promise<AccountLogin>;

/** gh first, glab only when gh has no login. Pure apart from the two sources it is given. */
export function usernameLookup(github: UsernameSource, gitlab: UsernameSource): UsernameSource {
  return async () => {
    const fromGitHub = await github();
    if (fromGitHub.available) return fromGitHub;
    const fromGitLab = await gitlab();
    if (fromGitLab.available) return fromGitLab;
    return { available: false, reason: `${fromGitHub.reason}; ${fromGitLab.reason}` };
  };
}
