// Keeps the review-request store (store.ts) current while a window is connected. Which hosts are
// asked comes from the registered projects: GitHub when some project's `origin` is there, and each
// other server glab is signed in to. Each host is asked once for every repository on it, every
// REVIEW_POLL_MS, and at once when the projects' folders change (a project added is where a
// request may now belong). The server is loopback only, so a host cannot tell it anything: it asks.
// A request is given the project whose remote is its repository, or none.
import type { Project, ProjectFolder } from '../model.ts';
import { canonicalHost, isGithubHost, remoteHost, remoteRepository } from '../pull-requests/choose.ts';
import type { GlabSignInCheck } from '../pull-requests/glab.ts';
import { repositoryKey, reviewRequestKey, type FoundReviewRequest, type ReviewRequest } from '../shared/review-requests.ts';
import { ready, type Sourced } from '../shared/sourced.ts';
import type { ReviewRequestLookup } from './github.ts';
import type { HostReviewRequestLookup } from './gitlab.ts';
import type { ReviewRequestStore } from './store.ts';

export const REVIEW_POLL_MS = 90_000;
/** How often the sync looks at whether it is time to ask, or the projects changed. */
export const REVIEW_CHECK_MS = 5_000;

export interface ReviewRequestSources {
  github: ReviewRequestLookup;
  gitlab: HostReviewRequestLookup;
  glabSignIn: GlabSignInCheck;
  /** The URL of a repository's origin remote, or null. */
  originOf(repoPath: string): Promise<string | null>;
}

/** A project folder's remote, as far as review requests care. */
export interface ProjectRemote {
  projectId: string;
  hostName: string;
  repository: string;
}

/** A project's remote from its origin URL; null for no remote, a local one, or one with no repository path. Pure. */
export function projectRemote(projectId: string, origin: string | null): ProjectRemote | null {
  const host = origin ? remoteHost(origin) : null;
  const repository = origin ? remoteRepository(origin) : null;
  return host && repository ? { projectId, hostName: canonicalHost(host), repository } : null;
}

/** The hosts to ask, in a steady order. Pure. */
export const hostsOf = (remotes: readonly ProjectRemote[]): string[] => [...new Set(remotes.map((r) => r.hostName))].sort();

/** Each found request with its key and its project: the first registered project on that repository. Pure. */
export function withProjects(found: readonly FoundReviewRequest[], remotes: readonly ProjectRemote[]): ReviewRequest[] {
  const projects = new Map<string, string>();
  for (const remote of remotes) {
    const key = repositoryKey(remote.hostName, remote.repository);
    if (!projects.has(key)) projects.set(key, remote.projectId);
  }
  return found.map((request) => ({ ...request, key: reviewRequestKey(request), projectId: projects.get(repositoryKey(request.hostName, request.repository)) ?? null }));
}

export interface ReviewRequestSync {
  /** Ask every host now, and wait for it. */
  check(): Promise<void>;
  /** Ask if it is time to: a window is connected, and the pace has passed or the projects' folders changed. */
  tick(): Promise<void>;
  stop(): void;
}

interface FolderOwner {
  projectId: string;
  folder: ProjectFolder;
}

/** What the sync reads of the workspace: its registered projects. */
export interface ProjectsSource {
  state(): Promise<{ projects: readonly Project[] }>;
}

export function syncReviewRequests(workspace: ProjectsSource, sources: ReviewRequestSources, store: ReviewRequestStore, watched: () => boolean, now: () => number = Date.now): ReviewRequestSync {
  let askedAt: number | null = null;
  let askedFor = '';
  let running: Promise<void> | null = null;

  const folders = async (): Promise<FolderOwner[]> => (await workspace.state()).projects.flatMap((project) => project.folders.map((folder) => ({ projectId: project.id, folder })));
  const signature = (owners: readonly FolderOwner[]): string => owners.map((o) => `${o.projectId}:${o.folder.path}`).join('\n');

  const askHost = async (hostName: string): Promise<Sourced<FoundReviewRequest[]>> => {
    if (isGithubHost(hostName)) return sources.github();
    const signIn = await sources.glabSignIn(hostName);
    // A server glab is not signed in to has no requests to show and nothing wrong to report here:
    // the session's own pull-request lookup already says how to connect it.
    return signIn.signedIn ? sources.gitlab(hostName) : ready([]);
  };

  const ask = async (owners: readonly FolderOwner[]): Promise<void> => {
    const origins = await Promise.all(owners.map(async (o) => projectRemote(o.projectId, await sources.originOf(o.folder.path).catch(() => null))));
    const remotes = origins.filter((r): r is ProjectRemote => r !== null);
    const hosts = hostsOf(remotes);
    store.keep(hosts);
    await Promise.all(
      hosts.map(async (hostName) => {
        const answer = await askHost(hostName);
        if (!watched()) return; // switched off, or the last window closed, while the host was asked
        store.set(hostName, answer.state === 'ready' ? ready(withProjects(answer.value, remotes)) : answer);
      }),
    );
  };

  const run = (owners: readonly FolderOwner[]): Promise<void> => {
    askedAt = now();
    askedFor = signature(owners);
    running ??= ask(owners)
      .catch((error: unknown) => console.error('[kestrel] could not check review requests', error))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const tick = async (): Promise<void> => {
    if (running || !watched()) return;
    const owners = await folders();
    if (askedAt !== null && now() - askedAt < REVIEW_POLL_MS && signature(owners) === askedFor) return;
    await run(owners);
  };

  const timer = setInterval(() => void tick().catch((error: unknown) => console.error('[kestrel] could not check review requests', error)), REVIEW_CHECK_MS);
  void tick();

  return {
    check: async () => run(await folders()),
    tick,
    stop: () => clearInterval(timer),
  };
}
