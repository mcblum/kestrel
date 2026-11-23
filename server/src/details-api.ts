// HTTP routes for a session's Details pane. Each section has its own source, and each answers with
// a Sourced value (shared/sourced.ts): ready, or unavailable with a reason. Shaped like
// organize-api.ts: the caller hands over the path parts and gets an answer, or null.
//
//   GET /api/sessions/:id/git                         { state, ... GitStatus }
//   GET /api/sessions/:id/pull-requests[?refresh=1]   { state, ... PullRequestLookup }   from the PR store (pull-requests/store.ts)
//
// A session's pull requests are those on its current branch plus every one linked to it before
// (pull-requests/session-requests.ts), so a branch change does not hide the ones it opened earlier.
// Each lookup records the state it saw each request in; a change there moves the session's status.
//   GET /api/sessions/:id/usage                       { state, ... SessionUsage }
//   GET /api/sessions/:id/change-counts               { state, ... ChangeCounts }   a sidebar row's changes icon
import { diffCounts } from './shared/diff-counts.ts';
import { existsSync } from 'node:fs';
import { originUrl } from './git.ts';
import { repositoryWebUrl } from './repository-url.ts';
import { changeCountsOf, gitStatusOf } from './git-status.ts';
import { sampleChangeCounts, sampleGitStatus } from './git-status-sample.ts';
import type { ProjectFolder, Session, SessionView, WorkspaceState } from './model.ts';
import { folderOf } from './shared/project-folders.ts';
import { syncBranch } from './branch-sync.ts';
import { PullRequestStore } from './pull-requests/store.ts';
import { githubByNumber, gitlabByNumber } from './pull-requests/by-number.ts';
import { lookupFrom, pullRequestsFor } from './pull-requests/choose.ts';
import { samplePullRequests, type SamplePullRequests } from './pull-requests/fake.ts';
import { githubProvider } from './pull-requests/github.ts';
import { gitlabProvider } from './pull-requests/gitlab.ts';
import { sharedGlabSignIn } from './pull-requests/glab.ts';
import { fetchLinked, linkedRequestsFor, linksCacheKey, NO_BRANCH, sessionPullRequests, type SessionRequestSources } from './pull-requests/session-requests.ts';
import { readUsage, type ChangeCounts, type PullRequestLookup } from './shared/details.ts';
import { ready, unavailable, type Sourced } from './shared/sourced.ts';
import type { SessionRuntime } from './runtime.ts';
import type { Workspace } from './workspace.ts';

export type DetailsAnswer = { status: number; body?: unknown };

const MAX_ID = 100;
const SECTIONS = new Set(['git', 'pull-requests', 'usage', 'repository', 'change-counts']);
export const NOT_RECORDED = 'Not recorded for this session';

export interface DetailsSources {
  /** Pull requests for a repository's branch, and linked ones by number, with which kind of host answered. */
  pullRequests: SessionRequestSources;
  store: PullRequestStore;
  /** The sample provider, which "Create pull request" adds to (fake store only). */
  samples?: SamplePullRequests;
}

/** The real sources (gh or glab by origin remote), or the sample provider (GitHub-flavoured) for the fake store. */
export function detailsSources(sample: boolean): DetailsSources {
  if (sample) {
    const samples = samplePullRequests();
    const pullRequests: SessionRequestSources = {
      pullRequestsFor: (repo, branch) => lookupFrom('github', samples, repo, branch),
      linkedRequests: (repo, links) => fetchLinked(samples, 'github', repo, links.filter((link) => link.host === 'github')),
    };
    return { pullRequests, store: new PullRequestStore(), samples };
  }
  const sources = { github: githubProvider(), gitlab: gitlabProvider(), glabSignIn: sharedGlabSignIn, originOf: originUrl };
  const linked = { github: githubByNumber(), gitlab: gitlabByNumber(), glabSignIn: sharedGlabSignIn, originOf: originUrl };
  const pullRequests: SessionRequestSources = {
    pullRequestsFor: (repo, branch) => pullRequestsFor(sources, repo, branch),
    linkedRequests: (repo, links) => linkedRequestsFor(linked, repo, links),
  };
  return { pullRequests, store: new PullRequestStore() };
}

/** Why a session's pull requests cannot be asked for, or null when they can. */
function noPullRequestsReason(session: Session, project: ProjectFolder | null, sample: boolean): string | null {
  if (!project) return 'No repository';
  if (!project.isGit) return 'Plain folder, no change history';
  if (!sample && !existsSync(project.path)) return 'The project folder is missing';
  if (!session.branch) return NO_BRANCH; // checked last: with links, a session with no branch still has an answer
  return null;
}

async function pullRequestsOf(session: Session, project: ProjectFolder | null, workspace: Workspace, sources: DetailsSources, refresh: boolean, sample: boolean): Promise<Sourced<PullRequestLookup>> {
  const reason = noPullRequestsReason(session, project, sample);
  // Answers that need no host are kept in the store too, so every session in sight has one.
  const without = (why: string) => sources.store.get(session.id, `none\n${why}`, async () => unavailable(why), refresh);
  if (!project || (reason && reason !== NO_BRANCH)) return without(reason ?? 'No repository');
  const links = await workspace.requestLinks(session.id);
  if (reason && links.length === 0) return without(reason);
  const branch = session.branch;
  // A link made on another branch changes the key, so it is shown at once (linksCacheKey).
  const key = `${project.path}\n${branch ?? ''}\n${linksCacheKey(links, branch)}`;
  const record = (seen: Parameters<typeof workspace.recordRequests>[1]) => workspace.recordRequests(session.id, seen);
  return sources.store.get(session.id, key, () => sessionPullRequests(sources.pullRequests, project.path, branch, links, record), refresh);
}

/**
 * A session's pull requests as its Details route answers them: on the branch its worktree is on
 * now, through the PR store. The workspace's Pull requests page asks this too (pull-request-list-api.ts),
 * so a session one place already looked up costs the other nothing.
 */
export async function sessionLookup(state: WorkspaceState, stored: SessionView, workspace: Workspace, sources: DetailsSources, refresh: boolean, sample: boolean): Promise<Sourced<PullRequestLookup>> {
  const session = sample ? stored : { ...stored, branch: await syncBranch(workspace, stored) };
  const started = state.projects.find((p) => p.id === session.startedIn);
  const project = started ? folderOf(started, session.folderId) : null;
  return pullRequestsOf(session, project, workspace, sources, refresh, sample);
}

async function usageOf(id: string, workspace: Workspace, runtime: SessionRuntime | undefined) {
  const usage = readUsage(runtime?.overlay(id)?.usage) ?? readUsage((await workspace.storedDetail(id))?.usage);
  return usage ? ready(usage) : unavailable(NOT_RECORDED);
}

/** The fake store's counts: its seeded Changes (stored with the session), not a worktree. */
async function sampleCountsOf(session: Session, workspace: Workspace): Promise<Sourced<ChangeCounts> | null> {
  if (!session.worktreePath) return null;
  return sampleChangeCounts(session.branch, (await workspace.storedDetail(session.id))?.files?.length ?? 0);
}

/**
 * The counts with the lines added and removed, from the session's changed files as it holds them:
 * the same files, counted the same way, as the session bar shows (shared/diff-counts.ts).
 */
async function withLineCounts(counts: Sourced<ChangeCounts>, sessionId: string, workspace: Workspace, runtime: SessionRuntime | undefined): Promise<Sourced<ChangeCounts>> {
  if (counts.state !== 'ready') return counts;
  // The live list when the session has one: it is what the bar shows, and newer than what is stored.
  const files = runtime?.overlay(sessionId)?.files ?? (await workspace.storedDetail(sessionId))?.files ?? [];
  return { ...counts, value: { ...counts.value, ...diffCounts(files.map((f) => f.diff)) } };
}

/** Answers a Details route, or null when the path is not one. */
export async function detailsRoute(parts: readonly string[], method: string, url: URL, workspace: Workspace, runtime: SessionRuntime | undefined, sources: DetailsSources, sample: boolean): Promise<DetailsAnswer | null> {
  if (method !== 'GET' || parts[1] !== 'sessions' || parts.length !== 4 || !SECTIONS.has(parts[3]!)) return null;
  const id = parts[2]!;
  if (id.length > MAX_ID) return { status: 400, body: { error: 'The session id is too long.' } };
  const refresh = url.searchParams.get('refresh');
  if (refresh !== null && refresh !== '1') return { status: 400, body: { error: 'refresh must be 1 or absent.' } };
  const state = await workspace.state();
  const stored = state.sessions.find((s) => s.id === id);
  if (!stored) return { status: 404, body: { error: 'No such session' } };
  // Details are about the branch the worktree is on now, not the one it was made with (branch-sync.ts).
  const session = sample ? stored : { ...stored, branch: await syncBranch(workspace, stored) };
  // The directory the session works in: a project with several has one per session.
  const started = state.projects.find((p) => p.id === session.startedIn);
  const project = started ? folderOf(started, session.folderId) : null;
  if (parts[3] === 'repository') {
    if (!project?.isGit) return { status: 200, body: unavailable('No Git repository') };
    const link = repositoryWebUrl(await originUrl(project.path));
    return { status: 200, body: link ? ready(link) : unavailable('No web remote configured') };
  }
  if (parts[3] === 'git') return { status: 200, body: (sample && sampleGitStatus(session.branch)) || (await gitStatusOf(session, project)) };
  if (parts[3] === 'change-counts') {
    const sampled = sample ? await sampleCountsOf(session, workspace) : null;
    const counts = sampled ?? (await changeCountsOf(session, project));
    // A count taken from the worktree that the session's list does not match: the list is read again.
    if (!sampled && counts.state === 'ready') runtime?.changesCounted(id, counts.value.changed);
    return { status: 200, body: await withLineCounts(counts, id, workspace, runtime) };
  }
  if (parts[3] === 'usage') return { status: 200, body: await usageOf(id, workspace, runtime) };
  return { status: 200, body: await pullRequestsOf(session, project, workspace, sources, refresh === '1', sample) };
}
