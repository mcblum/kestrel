// "Review this pull request", said as the first message of an ordinary session (0.0.23; Matt,
// 2026-11-21). Such a session is not a review: its worktree is not at the request's commit, it
// has no review card, and it is not drawn with the code reviews. So the agent calls `start_review`
// and Kestrel offers to make it one: on a yes a real review session is started for that request
// (start.ts) and takes this one's place; this one is removed when its turn ends.
//
// Here: reading what the user named (a link, or a number in the session's own project), finding
// the registered project it belongs to, and the words for each way it can go. A request in no
// registered project cannot become a review session; the agent is told to say so and to offer the
// two ways on: add the project, or have the review here as plain text.
import type { Project, ProjectFolder } from '../model.ts';
import { canonicalHost, remoteHost, remoteRepository } from '../pull-requests/choose.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { repositoryKey } from '../shared/review-requests.ts';

/** A pull or merge request as the user named it. `hostName` and `repository` are absent for a bare number. */
export type RequestRef = { number: number; host?: HostKind; hostName?: string; repository?: string; url?: string };

/**
 * A pull request link (GitHub: `…/owner/repo/pull/7`; GitLab: `…/group/sub/repo/-/merge_requests/7`),
 * or a bare number ("7", "#7", "!7") for the session's own project. Null when it is neither. Pure.
 */
export function parseRequestRef(text: string): RequestRef | null {
  const given = text.trim();
  const bare = /^[#!]?(\d{1,9})$/.exec(given);
  if (bare) return { number: Number(bare[1]) };
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  const gitlab = /^\/(.+?)\/-\/merge_requests\/(\d{1,9})(?:\/.*)?$/.exec(path);
  if (gitlab) return { host: 'gitlab', hostName: url.host.toLowerCase(), repository: gitlab[1]!, number: Number(gitlab[2]), url: `${url.origin}/${gitlab[1]}/-/merge_requests/${gitlab[2]}` };
  const github = /^\/([^/]+\/[^/]+)\/pull\/(\d{1,9})(?:\/.*)?$/.exec(path);
  if (github) return { host: 'github', hostName: url.host.toLowerCase(), repository: github[1]!, number: Number(github[2]), url: `${url.origin}/${github[1]}/pull/${github[2]}` };
  return null;
}

export interface RequestHome {
  project: Project;
  folder: ProjectFolder;
  host: HostKind;
  hostName: string;
  repository: string;
}

/** The host a remote is on, by its name: GitLab's own and self-hosted ones say so; anything else is taken as GitHub (github.com, GitHub Enterprise). */
export const hostKindOf = (hostName: string): HostKind => (/gitlab/i.test(hostName) ? 'gitlab' : 'github');

/**
 * The registered project folder a request belongs to. A link: the folder whose `origin` is that
 * repository. A bare number: the first git folder of the session's own project. Null when there
 * is none. `hostOf` says which kind of host a folder's remote is on when the link did not.
 */
export async function requestHome(ref: RequestRef, projects: readonly Project[], ownProjectId: string | null, originOf: (path: string) => Promise<string | null>): Promise<RequestHome | null> {
  const candidates = ref.repository ? projects : projects.filter((p) => p.id === ownProjectId);
  for (const project of candidates) {
    for (const folder of project.folders) {
      if (!folder.isGit) continue;
      const origin = await originOf(folder.path).catch(() => null);
      const host = origin ? remoteHost(origin) : null;
      const repository = origin ? remoteRepository(origin) : null;
      if (!host || !repository) continue;
      const hostName = canonicalHost(host);
      if (ref.repository && ref.hostName && repositoryKey(hostName, repository) !== repositoryKey(canonicalHost(ref.hostName), ref.repository)) continue;
      return { project, folder, host: ref.host ?? hostKindOf(hostName), hostName, repository };
    }
  }
  return null;
}

// ---- the words ---------------------------------------------------------------------------------

export const NOT_A_REQUEST = 'pull_request must be the link of a pull or merge request, or its number when it is in this session\'s own project.';
export const NOT_FIRST_MESSAGE = 'This conversation is already under way, so it is not replaced by a review session. Review the change here, in plain text, or tell the user to start a new session with "Review <link>" for a review session.';
export const ALREADY_A_REVIEW = 'This session is already a review session. Review the change and hand it over with post_review.';

/** For a request in no registered project: what the agent is to tell the user, and that it may go on. */
export const noProjectFor = (what: string): string =>
  `${what} is not in a project registered in Kestrel, so it cannot be a review session (those are checked out at the request's commit, in its project). Tell the user the two ways on, and ask which they want: add that repository as a project in Kestrel and ask again, or have the review here as ordinary text. If they choose the second, review it here and write what you find in your reply.`;

export const convertAsk = (what: string, project: string): { title: string; detail: string } => ({
  title: 'Make this a review session?',
  detail: `A review session of ${what} would start in ${project}: checked out at the request's commit, with its findings as cards you can edit and post, and listed with your code reviews. This session would be removed and that one would take its place.\n\nDecline to have the review here as ordinary text.`,
});

export const CONVERT_DECLINED = 'The user chose to keep this as an ordinary session. Review the change here and write what you find in your reply, as plain text.';
export const converted = (title: string, id: string): string => `A review session has started: "${title}" (${id}). It does the review; this session is removed when this turn ends. Do nothing more here: end your turn now, with at most one sentence.`;
