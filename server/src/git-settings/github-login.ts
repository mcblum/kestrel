// The GitHub login of whoever gh is signed in as, the first source for the "Your username" branch
// prefix. Asked once (`gh api user --jq .login`, no shell, with a time limit) and kept for the
// server's lifetime, answer or reason alike: signing in to gh takes effect after Kestrel is reopened.
// The runner is injected, so tests never call the real gh.
import { homedir } from 'node:os';
import { execRunner, ghFailureReason, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { customPrefixProblem } from '../shared/branch-prefix.ts';

/** An account name to use in branch names, and where it is from ("GitHub", a GitLab host), or why there is none. */
export type AccountLogin = { available: true; login: string; service: string } | { available: false; reason: string };
export type GitHubLogin = AccountLogin;

export const LOGIN_ARGS = ['api', 'user', '--jq', '.login'] as const;

/** One gh answer as a login, or why there is none. Pure. */
export function loginFromOutput(stdout: string): GitHubLogin {
  const login = stdout.trim();
  if (!login) return { available: false, reason: 'gh did not say which GitHub account is signed in' };
  if (customPrefixProblem(login) !== null) return { available: false, reason: `The GitHub login "${login.slice(0, 40)}" cannot be used in a branch name` };
  return { available: true, login, service: 'GitHub' };
}

/** Asks gh once; every later call gets the same answer. */
export function githubLoginLookup(run: CommandRunner = execRunner, cwd: string = homedir()): () => Promise<GitHubLogin> {
  let answer: Promise<GitHubLogin> | null = null;
  return () => {
    answer ??= run('gh', LOGIN_ARGS, { cwd, timeoutMs: GH_TIMEOUT_MS }).then(
      ({ stdout }) => loginFromOutput(stdout),
      (error: unknown) => ({ available: false as const, reason: ghFailureReason(error) }),
    );
    return answer;
  };
}

/** With sample data neither gh nor glab is asked: a made-up GitHub login stands in. */
export const sampleUsername = (): Promise<AccountLogin> => Promise.resolve({ available: true, login: 'octocat', service: 'GitHub' });
