// The merge requests a GitLab server says the user was asked to review, through `glab api`: who
// the user is there (`user`, asked once per server), then every open merge request with them as a
// reviewer, across projects. A GitLab reviewer is always a person, so there is no team to leave
// out. Drafts are left out. The runner is injected: tests never call glab.
import { homedir } from 'node:os';
import { execRunner } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { FoundReviewRequest } from '../shared/review-requests.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { REVIEW_REQUEST_LIMIT } from './github.ts';
import { gitlabFindRequester, withRequesters } from './requester.ts';

export const gitlabUserArgs = (host: string): string[] => ['api', 'user', '--hostname', host];
export const gitlabReviewArgs = (host: string, username: string): string[] => [
  'api',
  `merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(username)}&per_page=${REVIEW_REQUEST_LIMIT}`,
  '--hostname',
  host,
];

type Fields = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;

/** The project's full path from `references.full` ("group/name!12"), else from the address. Pure. */
export function repositoryOfMergeRequest(item: Fields): string | null {
  const full = isFields(item.references) ? text(item.references.full) : '';
  const fromReference = /^(.+)!\d+$/.exec(full);
  if (fromReference) return fromReference[1]!;
  const fromUrl = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(text(item.web_url));
  return fromUrl ? fromUrl[1]! : null;
}

/** One merge request as a request; null for a draft or one Kestrel cannot name. Pure. */
export function mapGitlabItem(item: Fields, host: string): FoundReviewRequest | null {
  const repository = repositoryOfMergeRequest(item);
  if (!repository || typeof item.iid !== 'number' || item.draft === true || item.work_in_progress === true) return null;
  const body = text(item.description);
  return {
    host: 'gitlab',
    hostName: host,
    repository,
    number: item.iid,
    title: text(item.title) || `!${item.iid}`,
    author: isFields(item.author) ? text(item.author.username) : '',
    url: /^https?:\/\//.test(text(item.web_url)) ? text(item.web_url) : '',
    updatedAt: Date.parse(text(item.updated_at)) || 0,
    ...(body ? { body } : {}),
  };
}

/** The list's answer as requests. Throws when it is not a list. Pure. */
export function mapGitlabList(json: string, host: string): FoundReviewRequest[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('glab did not answer with a list');
  return parsed.filter(isFields).flatMap((item) => mapGitlabItem(item, host) ?? []);
}

/** The signed-in user's name from `glab api user`. Throws when there is none. Pure. */
export function gitlabUsername(json: string): string {
  const parsed: unknown = JSON.parse(json);
  const username = isFields(parsed) ? text(parsed.username) : '';
  if (!username) throw new Error('glab did not say who is signed in');
  return username;
}

export type HostReviewRequestLookup = (host: string) => Promise<Sourced<FoundReviewRequest[]>>;

export function gitlabReviewRequests(run: CommandRunner = execRunner, cwd: string = homedir()): HostReviewRequestLookup {
  // Who the user is on each server: asked once and kept, as the sign-in is (glab.ts).
  let usernames: ReadonlyMap<string, string> = new Map();
  const requesters = withRequesters(gitlabFindRequester((host) => usernames.get(host), run, cwd));
  return async (host) => {
    try {
      let username = usernames.get(host);
      if (!username) {
        username = gitlabUsername((await run('glab', gitlabUserArgs(host), { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout);
        usernames = new Map(usernames).set(host, username);
      }
      const { stdout } = await run('glab', gitlabReviewArgs(host, username), { cwd, timeoutMs: GLAB_TIMEOUT_MS });
      return ready(await requesters(mapGitlabList(stdout, host)));
    } catch (error) {
      return unavailable(glabFailureReason(error, host));
    }
  };
}
