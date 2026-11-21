// The `glab` CLI, GitLab's counterpart to gh: whether it is signed in to a host (asked once per host
// with `glab auth status --hostname <host>` and kept for the server's lifetime, failures included,
// like git-settings/github-login.ts: signing in takes effect after Kestrel is reopened), and its
// failures said plainly. The runner is injected, so tests never call the real glab.
import { homedir } from 'node:os';
import { reasonOf } from '../shared/sourced.ts';
import { execRunner } from './github.ts';
import type { CommandRunner } from './types.ts';

export const GLAB_TIMEOUT_MS = 10_000;

export type GlabSignIn = { signedIn: true } | { signedIn: false; reason: string };
/** Whether glab is signed in to a host. */
export type GlabSignInCheck = (host: string) => Promise<GlabSignIn>;

/** What to do to connect a host's merge requests. */
export const connectHint = (host: string): string => `Install glab and run \`glab auth login --hostname ${host}\` to connect merge requests`;
const signInHint = (host: string): string => `glab is not signed in to ${host}: run \`glab auth login --hostname ${host}\` to connect merge requests`;

export const authStatusArgs = (host: string): string[] => ['auth', 'status', '--hostname', host];

/** Why glab could not answer, said plainly; `host` names the server when it is known. */
export function glabFailureReason(error: unknown, host?: string): string {
  const e = error as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (e?.code === 'ENOENT') return host ? connectHint(host) : 'The glab command is not installed (or not on Kestrel’s PATH)';
  if (e?.killed === true) return `glab did not answer within ${GLAB_TIMEOUT_MS / 1000} seconds`;
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
  if (/glab auth login|not logged in|no token|401 unauthorized/i.test(stderr)) return host ? signInHint(host) : 'glab is not signed in (run glab auth login)';
  return stderr.trim() ? reasonOf(new Error(stderr)) : reasonOf(error);
}

/** One `glab auth status` outcome as a sign-in answer. A non-zero exit means not signed in. Pure. */
export function signInFromFailure(error: unknown, host: string): GlabSignIn {
  const e = error as { code?: unknown; killed?: unknown };
  if (e?.code === 'ENOENT' || e?.killed === true) return { signedIn: false, reason: glabFailureReason(error, host) };
  return { signedIn: false, reason: signInHint(host) };
}

/** Asks glab once per host; every later call for that host gets the same answer. */
export function glabSignInLookup(run: CommandRunner = execRunner, cwd: string = homedir()): GlabSignInCheck {
  let answers: ReadonlyMap<string, Promise<GlabSignIn>> = new Map();
  return (host) => {
    const known = answers.get(host);
    if (known) return known;
    const answer = run('glab', authStatusArgs(host), { cwd, timeoutMs: GLAB_TIMEOUT_MS }).then(
      (): GlabSignIn => ({ signedIn: true }),
      (error: unknown) => signInFromFailure(error, host),
    );
    answers = new Map(answers).set(host, answer);
    return answer;
  };
}

/** The server's one lookup: the provider choice, creation and Settings → Git share its answers. */
let shared: GlabSignInCheck | null = null;
export const sharedGlabSignIn: GlabSignInCheck = (host) => (shared ??= glabSignInLookup())(host);
