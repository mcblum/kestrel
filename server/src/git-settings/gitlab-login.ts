// The GitLab username of whoever glab is signed in as, for "Your username" when gh has no login.
// The host is glab's default (`glab config get host --global`; gitlab.com when unset); glab must be
// signed in to it (the shared sign-in check, pull-requests/glab.ts), then `glab api --hostname <host>
// user` names the account. Asked once and kept for the server's lifetime, answer or reason alike.
// The runner is injected, so tests never call the real glab.
import { homedir } from 'node:os';
import { execRunner } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason, sharedGlabSignIn, type GlabSignInCheck } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { customPrefixProblem } from '../shared/branch-prefix.ts';
import type { AccountLogin } from './github-login.ts';

/** glab's own default host. */
export const GLAB_DEFAULT_HOST = 'gitlab.com';
export const HOST_ARGS = ['config', 'get', 'host', '--global'] as const;
export const userArgs = (host: string): string[] => ['api', '--hostname', host, 'user'];

/** `glab api user` output as a login, or why there is none. Pure. */
export function gitlabLoginFromOutput(stdout: string, host: string): AccountLogin {
  let username: unknown;
  try {
    username = (JSON.parse(stdout) as { username?: unknown }).username;
  } catch {
    return { available: false, reason: `glab gave an answer Kestrel cannot read for ${host}` };
  }
  if (typeof username !== 'string' || !username.trim()) return { available: false, reason: `glab did not say which ${host} account is signed in` };
  if (customPrefixProblem(username) !== null) return { available: false, reason: `The GitLab username "${username.slice(0, 40)}" cannot be used in a branch name` };
  return { available: true, login: username, service: host === GLAB_DEFAULT_HOST ? 'GitLab' : host };
}

/** glab's configured host as a bare host name (a stray scheme or slash dropped); unset is gitlab.com. Pure. */
export const hostFromConfig = (stdout: string): string => stdout.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') || GLAB_DEFAULT_HOST;

async function askGlab(run: CommandRunner, signIn: GlabSignInCheck, cwd: string): Promise<AccountLogin> {
  const options = { cwd, timeoutMs: GLAB_TIMEOUT_MS };
  let host: string;
  try {
    host = hostFromConfig((await run('glab', HOST_ARGS, options)).stdout);
  } catch (error) {
    return { available: false, reason: glabFailureReason(error) };
  }
  const status = await signIn(host);
  if (!status.signedIn) return { available: false, reason: status.reason };
  try {
    return gitlabLoginFromOutput((await run('glab', userArgs(host), options)).stdout, host);
  } catch (error) {
    return { available: false, reason: glabFailureReason(error, host) };
  }
}

/** Asks glab once; every later call gets the same answer. */
export function gitlabLoginLookup(run: CommandRunner = execRunner, signIn: GlabSignInCheck = sharedGlabSignIn, cwd: string = homedir()): () => Promise<AccountLogin> {
  let answer: Promise<AccountLogin> | null = null;
  return () => (answer ??= askGlab(run, signIn, cwd));
}
