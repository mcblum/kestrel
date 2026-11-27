// Which pull-request provider answers for a repository, chosen by its `origin` remote. GitHub hosts
// go to gh. Any other host goes to GitLab through glab when glab is signed in to that host (asked
// through an injected check, glab.ts); self-hosted GitLab servers rarely say "gitlab" in their name,
// so the host's name is never the test. Otherwise the reason says what to do, instead of looking
// like "no pull requests".
import type { PullRequestLookup } from '../shared/details.ts';
import { isGithubHost, type HostKind } from '../shared/host-terms.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import type { GlabSignIn, GlabSignInCheck } from './glab.ts';
import type { PullRequestProvider } from './types.ts';

export { canonicalHost, isGithubHost } from '../shared/host-terms.ts';

/** The host of a remote URL (https, ssh:// or scp-like git@host:path), or null for a local path. Pure. */
export function remoteHost(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)/.exec(trimmed);
  if (scp) return scp[1]!.toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}


/**
 * The repository a remote URL names on its host ("owner/name", or a GitLab group path), without
 * `.git`; null for a local path or a URL with no path. Pure.
 */
export function remoteRepository(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^[^@/\s]+@[^:/\s]+:(?!\/)(.+)$/.exec(trimmed);
  let path: string;
  if (scp) path = scp[1]!;
  else {
    if (!remoteHost(trimmed)) return null;
    try {
      path = decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return null;
    }
  }
  const repository = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return repository.includes('/') ? repository : null;
}

export type ProviderChoice = { kind: 'github' } | { kind: 'gitlab'; host: string } | { kind: 'none'; reason: string };

/** The host whose glab sign-in decides the choice, or null when none is needed (GitHub, no remote, a folder). Pure. */
export function hostNeedingGlab(origin: string | null): string | null {
  const host = origin ? remoteHost(origin) : null;
  return host && !isGithubHost(host) ? host : null;
}

/**
 * What answers for a repository with this origin URL (null: no origin remote), given glab's sign-in
 * for that host when it is not GitHub (absent: not asked, read as not connected). Pure.
 */
export function chooseProvider(origin: string | null, glab?: GlabSignIn): ProviderChoice {
  if (!origin) return { kind: 'none', reason: 'This repository has no remote' };
  const host = remoteHost(origin);
  if (!host) return { kind: 'none', reason: 'The origin remote is a folder on this computer, not a hosting service' };
  if (isGithubHost(host)) return { kind: 'github' };
  if (glab?.signedIn) return { kind: 'gitlab', host };
  return { kind: 'none', reason: glab?.signedIn === false ? glab.reason : `No connection to ${host} yet` };
}

/** `chooseProvider` with glab asked first when the host needs it. */
export async function resolveProvider(origin: string | null, glabSignIn: GlabSignInCheck): Promise<ProviderChoice> {
  const host = hostNeedingGlab(origin);
  return chooseProvider(origin, host ? await glabSignIn(host) : undefined);
}

export interface PullRequestSources {
  github: PullRequestProvider;
  gitlab: PullRequestProvider;
  glabSignIn: GlabSignInCheck;
  /** The URL of a repository's origin remote, or null. */
  originOf(repoPath: string): Promise<string | null>;
}

/** A provider's answer with which kind of host gave it, so the UI can use that host's words. */
export async function lookupFrom(host: HostKind, provider: PullRequestProvider, repoPath: string, branch: string): Promise<Sourced<PullRequestLookup>> {
  const found = await provider.pullRequestsFor(repoPath, branch);
  return found.state === 'ready' ? ready({ host, pullRequests: found.value }) : found;
}

/** The pull requests for a branch, from whichever provider the repository's remote calls for. */
export async function pullRequestsFor(sources: PullRequestSources, repoPath: string, branch: string): Promise<Sourced<PullRequestLookup>> {
  const choice = await resolveProvider(await sources.originOf(repoPath), sources.glabSignIn);
  if (choice.kind === 'none') return unavailable(choice.reason);
  return lookupFrom(choice.kind, sources[choice.kind], repoPath, branch);
}
