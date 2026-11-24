// Starting a review of somebody else's request: the commit to review is fetched into the project's
// repository and a session is started there whose worktree is at that commit, not at the request's
// branch, so what is reviewed does not move while it is read and the review can say which commit it
// is of. Its base is where that commit left the request's target branch, so the Changes pane shows
// the request's own diff. The session is an ordinary one, on the Review role's preset, with the
// review mark (shared/review-requests.ts), in Auto. Nothing here writes to the host but the one
// "Reviewing" comment the user may have asked for (reviewing.ts).
import type { WorktreeStart } from '../git.ts';
import { AGENT_LABEL, type Agent, type Project, type ProjectFolder, type Session } from '../model.ts';
import type { ByNumberProvider } from '../pull-requests/by-number.ts';
import { canonicalHost, remoteHost, remoteRepository } from '../pull-requests/choose.ts';
import { hostTerms, type HostKind } from '../shared/host-terms.ts';
import { remoteStartPermission, type PermissionLevel } from '../shared/permissions.ts';

const remoteOr = (remote: boolean | undefined, level: PermissionLevel): PermissionLevel => (remote ? remoteStartPermission(level) : level);
import { repositoryKey, requestNumberLabel, REVIEW_PERMISSION, reviewSessionTitle, type ReviewMark, type ReviewRequest } from '../shared/review-requests.ts';
import { REVIEW_IS_LAST } from '../shared/review-reply.ts';
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../shared/review-settings.ts';
import { alreadyReviewing, type ReviewingComments } from './reviewing.ts';
import { reviewersOf, type ModelPreset, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { Refused } from '../workspace.ts';

/** Runs git in a repository and resolves with what it printed; `allowFail` resolves with '' instead of rejecting. */
export type GitRun = (cwd: string, args: string[], opts?: { allowFail?: boolean }) => Promise<string>;

/** The ref a host keeps a request's head under, whoever's fork it came from. Pure. */
export const requestHeadRef = (host: HostKind, number: number): string => (host === 'github' ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`);

/**
 * What a review session's branch is named under. Every session's worktree is on a branch of its
 * own (its base is kept with the branch), and a review's is at the request's commit; named this
 * way, and not under the user's own prefix, it does not read as a branch of their work (Matt,
 * 2026-11-21: "mcblum/review-…" looked like one).
 */
export const REVIEW_BRANCH_PREFIX = 'kestrel-review';

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
  // The host said which branch it targets; failing that the remote's default as this clone has it
  // recorded, then as the remote itself says (a clone made with `git remote add` records none),
  // then the usual names. Without a target there is no base, and the review's Changes pane is empty.
  let target = targetBranch || remoteDefault || defaultBranchOf(await git(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD'], { allowFail: true })) || null;
  // Into the remote-tracking ref by name: a clone whose fetch is narrowed to one branch would otherwise leave `origin/<target>` unset.
  if (target) await git(repoPath, ['fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`], { allowFail: true });
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

/** The default branch a remote names in `git ls-remote --symref origin HEAD` ("ref: refs/heads/main\tHEAD"), or '' when it names none. Pure. */
export function defaultBranchOf(lsRemote: string): string {
  return /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRemote)?.[1] ?? '';
}

const firstLine = (error: unknown): string => {
  const e = error as { stderr?: unknown; message?: unknown };
  const text = typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e?.message ?? error);
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 200) ?? 'unknown error';
};

/** The first message of a review session: what to review, where it is, how (`instructions`: the user's own, '' for Kestrel's), and what not to do. Pure. */
export function reviewPrompt(request: Pick<ReviewRequest, 'host' | 'repository' | 'number' | 'title' | 'author' | 'url'>, sha: string, start: WorktreeStart, instructions = ''): string {
  const terms = hostTerms(request.host);
  const what = `${terms.long} ${requestNumberLabel(request)} in ${request.repository}`;
  const against = start.base === sha ? 'There is no commit to compare it with here, so read the code as it stands.' : `What it changes is \`git diff ${start.base.slice(0, 12)}...HEAD\`${start.baseRef ? `, against ${start.baseRef}` : ''}.`;
  return [
    `Review ${what}: "${request.title}"${request.author ? `, opened by ${request.author}` : ''}.`,
    request.url,
    `This worktree is at commit ${sha.slice(0, 12)}, the head of that ${terms.long} when this review started. ${against}`,
    // How to review and how to write it: the user's own words when they wrote some (shared/review-settings.ts).
    instructions.trim() || DEFAULT_REVIEW_INSTRUCTIONS,
    // How it is handed over is not theirs to change: the card is built from exactly this.
    'Hand over the review with the post_review tool, once: a verdict (approve, request_changes, or comment); a summary of a few sentences, which says what the change does and what you make of it overall; and the problems, each said once, as a finding. A finding has a brief (one or two plain sentences anyone can read), a detail (the technical explanation, which the user opens when they want it), a fix when you have one, a priority, whether you think it blocks the merge, and the lines of code it is about. For an approval with no findings, still include a concise summary of why the change is sound: the user needs that rationale even when approving without posting a comment. Do not list the problems in the summary as well: each is shown as its own card, and a list above them says everything twice.',
    REVIEW_IS_LAST,
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
  start(req: { agent: Agent; model: string; effort: string; fast: boolean; permission: PermissionLevel; projectId: string; folderId: string; prompt: string; title: string; start: WorktreeStart; review: ReviewMark }): Promise<Session>;
  /** The "Reviewing" comments (reviewing.ts); absent where nothing is asked of a host (sample data, tests). */
  reviewing?: ReviewingComments;
  /** Whether the user chose to say so on the request when a review begins (Settings → Code reviews). */
  announces?(): Promise<boolean>;
  /** The mode the user chose for reviews (Settings → Code reviews); Auto when not said. */
  permission?(): Promise<PermissionLevel>;
  /** The user's own review instructions; '' or absent for Kestrel's. */
  instructions?(): Promise<string>;
  /** Tell the user something in the review session (a comment that could not be posted). */
  notice?(sessionId: string, text: string): void;
  now?(): number;
}

export interface StartReviewOptions {
  /** Kestrel is starting it on its own, not the user: it holds back when somebody else is already reviewing. */
  automatic?: boolean;
  /** Another device of the account asked for it (A8): the mode is this computer's, never Bypass (`remoteStartPermission`). */
  remote?: boolean;
}

/**
 * Start the review of a request, or open the one already started: a request has one review session
 * at a time. Throws `Refused` with a reason the user can act on.
 */
export async function startReview(deps: StartReviewDeps, request: ReviewRequest, opts: StartReviewOptions = {}): Promise<Session> {
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
  const now = deps.now?.() ?? Date.now();
  // Who has already said "Reviewing". A host that cannot be asked holds nothing up: the review starts as it would have.
  const standing = deps.reviewing ? await deps.reviewing.standing(request, now).catch(() => null) : null;
  if (opts.automatic && standing?.other) throw new Refused(alreadyReviewing(standing.other, now));
  const { sha, start } = await reviewStart(deps.git, folder.path, request.host, request.number, target);
  const review: ReviewMark = { key: request.key, host: request.host, number: request.number, sha, url: request.url };
  const session = await deps.start({ agent: reviewer.agent, model: reviewer.model, effort: reviewer.effort, fast: reviewer.fast, permission: remoteOr(opts.remote, (await deps.permission?.()) ?? REVIEW_PERMISSION), projectId: project.id, folderId: folder.id, prompt: reviewPrompt(request, sha, start, (await deps.instructions?.()) ?? ''), title: reviewSessionTitle(request.title), start: { ...start, prefix: REVIEW_BRANCH_PREFIX }, review });
  // Said only once the review really started, and not twice: a comment of the user's own that still stands is enough.
  if (deps.reviewing && !standing?.mine && (await deps.announces?.())) {
    await deps.reviewing.announce(request, sha).catch((error: unknown) => deps.notice?.(session.id, `The review started, but Kestrel could not post the "Reviewing" comment on the ${terms.long}: ${firstLine(error)}`));
  }
  return session;
}
