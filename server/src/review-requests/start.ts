// Starting a review of somebody else's request: the commit to review is fetched into the project's
// repository and a session is started there whose worktree is at that commit, not at the request's
// branch, so what is reviewed does not move while it is read and the review can say which commit it
// is of. Its base is where that commit left the request's target branch, so the Changes pane shows
// the request's own diff. The session is an ordinary one, on the Review role's preset, with the
// review mark (shared/review-requests.ts). Nothing here writes to the host.
import type { WorktreeStart } from '../git.ts';
import { AGENT_LABEL, type Agent, type Project, type ProjectFolder, type Session } from '../model.ts';
import type { ByNumberProvider } from '../pull-requests/by-number.ts';
import { canonicalHost, remoteHost, remoteRepository } from '../pull-requests/choose.ts';
import { hostTerms, type HostKind } from '../shared/host-terms.ts';
import { repositoryKey, requestNumberLabel, reviewSessionTitle, type ReviewMark, type ReviewRequest } from '../shared/review-requests.ts';
import { reviewersOf, type ModelPreset, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { Refused } from '../workspace.ts';

/** Runs git in a repository and resolves with what it printed; `allowFail` resolves with '' instead of rejecting. */
export type GitRun = (cwd: string, args: string[], opts?: { allowFail?: boolean }) => Promise<string>;

/** The ref a host keeps a request's head under, whoever's fork it came from. Pure. */
export const requestHeadRef = (host: HostKind, number: number): string => (host === 'github' ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`);

/** Where Kestrel keeps the fetched head in the repository: out of the way of branches and tags. Pure. */
export const localReviewRef = (number: number): string => `refs/kestrel/review/${number}`;

const SHA = /^[0-9a-f]{7,64}$/i;
/** Tried, in order, when neither the host nor the remote says which branch a request targets. */
const USUAL_DEFAULTS = ['main', 'master'] as const;

/**
 * Fetch the request's head and its target branch from `origin`, and say where a worktree for the
 * review starts: at the head's commit, with the point it left the target branch as its base.
 * `targetBranch` null (the host did not say): the remote's default branch. Throws `Refused` with
 * what went wrong.
 */
export async function reviewStart(git: GitRun, repoPath: string, host: HostKind, number: number, targetBranch: string | null): Promise<{ sha: string; start: WorktreeStart }> {
  const terms = hostTerms(host);
  const local = localReviewRef(number);
  try {
    await git(repoPath, ['fetch', '--quiet', 'origin', `+${requestHeadRef(host, number)}:${local}`]);
  } catch (error) {
    throw new Refused(`Could not fetch ${terms.long} ${terms.sigil}${number} from origin: ${firstLine(error)}`);
  }
  const sha = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${local}^{commit}`], { allowFail: true })).trim();
  if (!SHA.test(sha)) throw new Refused(`Fetched ${terms.long} ${terms.sigil}${number}, but its commit could not be read.`);
  const remoteDefault = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })).trim().replace(/^origin\//, '');
  // The host said which branch it targets; failing that the remote's default, then the usual names.
  let target = targetBranch || remoteDefault || null;
  if (target) await git(repoPath, ['fetch', '--quiet', 'origin', target], { allowFail: true });
  for (const usual of target ? [] : USUAL_DEFAULTS) {
    if ((await git(repoPath, ['rev-parse', '--verify', '--quiet', `origin/${usual}`], { allowFail: true })).trim()) {
      target = usual;
      break;
    }
  }
  const fork = target ? (await git(repoPath, ['merge-base', sha, `origin/${target}`], { allowFail: true })).trim() : '';
  // No common commit with the target (or no target known): the review still starts, with nothing to compare against.
  return { sha, start: { head: sha, base: SHA.test(fork) ? fork : sha, baseRef: target } };
}

const firstLine = (error: unknown): string => {
  const e = error as { stderr?: unknown; message?: unknown };
  const text = typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e?.message ?? error);
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 200) ?? 'unknown error';
};

/** The first message of a review session: what to review, where it is, and what not to do. Pure. */
export function reviewPrompt(request: Pick<ReviewRequest, 'host' | 'repository' | 'number' | 'title' | 'author' | 'url'>, sha: string, start: WorktreeStart): string {
  const terms = hostTerms(request.host);
  const what = `${terms.long} ${requestNumberLabel(request)} in ${request.repository}`;
  const against = start.base === sha ? 'There is no commit to compare it with here, so read the code as it stands.' : `What it changes is \`git diff ${start.base.slice(0, 12)}...HEAD\`${start.baseRef ? `, against ${start.baseRef}` : ''}.`;
  return [
    `Review ${what}: "${request.title}"${request.author ? `, opened by ${request.author}` : ''}.`,
    request.url,
    `This worktree is at commit ${sha.slice(0, 12)}, the head of that ${terms.long} when this review started. ${against}`,
    'Read the change. Build it and run its tests when that tells you something. Then hand over the review with the post_review tool, once: a verdict (approve, request_changes, or comment), a summary of what the change does and the problems you found (most serious first), and a comment on each line that has a problem.',
    `Do not push anything, and do not comment on, approve or ask for changes to the ${terms.long} on ${terms.service} yourself: post_review shows your review to the user, who decides whether it is posted.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Who reviews: the first of the user's reviewers whose agent is connected; else the first connected agent, on its default model. Pure. */
export function reviewerPreset(who: WhoDoesWhat, connected: readonly Agent[]): Pick<ModelPreset, 'agent' | 'model' | 'effort' | 'fast'> | null {
  const preset = reviewersOf(who).find((r) => connected.includes(r.agent));
  if (preset) return preset;
  const agent = connected[0];
  return agent ? { agent, model: '', effort: '', fast: false } : null;
}

/** The project's directory whose `origin` is the request's repository, or null. */
export async function folderOfRequest(project: Project, request: Pick<ReviewRequest, 'hostName' | 'repository'>, originOf: (path: string) => Promise<string | null>): Promise<ProjectFolder | null> {
  const wanted = repositoryKey(request.hostName, request.repository);
  for (const folder of project.folders) {
    if (!folder.isGit) continue;
    const origin = await originOf(folder.path).catch(() => null);
    const host = origin ? remoteHost(origin) : null;
    const repository = origin ? remoteRepository(origin) : null;
    if (host && repository && repositoryKey(canonicalHost(host), repository) === wanted) return folder;
  }
  return null;
}

/** What starting a review needs from the rest of the server; tests pass their own. */
export interface StartReviewDeps {
  projects(): Promise<readonly Project[]>;
  sessions(): Promise<readonly Session[]>;
  originOf(path: string): Promise<string | null>;
  git: GitRun;
  byNumber(host: HostKind): ByNumberProvider;
  who(): Promise<WhoDoesWhat>;
  connectedAgents(): readonly Agent[];
  /** Start the session (the runtime's `start`, with a given title, start point and mark). */
  start(req: { agent: Agent; model: string; effort: string; fast: boolean; projectId: string; folderId: string; prompt: string; title: string; start: WorktreeStart; review: ReviewMark }): Promise<Session>;
}

/**
 * Start the review of a request, or open the one already started: a request has one review session
 * at a time. Throws `Refused` with a reason the user can act on.
 */
export async function startReview(deps: StartReviewDeps, request: ReviewRequest): Promise<Session> {
  const existing = (await deps.sessions()).find((s) => s.review?.key === request.key);
  if (existing) return existing;
  const terms = hostTerms(request.host);
  const project = request.projectId ? (await deps.projects()).find((p) => p.id === request.projectId) : undefined;
  if (!project) throw new Refused(`${request.repository} is not a project in Kestrel. Add it as a project, then start the review.`);
  const folder = await folderOfRequest(project, request, deps.originOf);
  if (!folder) throw new Refused(`No folder of ${project.name} has ${request.repository} as its origin remote any more.`);
  const reviewer = reviewerPreset(await deps.who(), deps.connectedAgents());
  if (!reviewer) throw new Refused('No agent is connected, so nothing can review this. Connect one in Settings → Connections.');
  if (!deps.connectedAgents().includes(reviewer.agent)) throw new Refused(`${AGENT_LABEL[reviewer.agent]} is not connected.`);
  const found = await deps.byNumber(request.host).pullRequestByNumber(folder.path, request.number);
  const target = found.state === 'ready' && found.value ? (found.value.baseBranch ?? null) : null;
  if (found.state === 'ready' && found.value && (found.value.state === 'merged' || found.value.state === 'closed')) throw new Refused(`This ${terms.long} is ${found.value.state} now, so there is nothing to review.`);
  const { sha, start } = await reviewStart(deps.git, folder.path, request.host, request.number, target);
  const review: ReviewMark = { key: request.key, host: request.host, number: request.number, sha, url: request.url };
  return deps.start({ agent: reviewer.agent, model: reviewer.model, effort: reviewer.effort, fast: reviewer.fast, projectId: project.id, folderId: folder.id, prompt: reviewPrompt(request, sha, start), title: reviewSessionTitle(request.title), start, review });
}
