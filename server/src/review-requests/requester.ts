// Who asked the user to review each request. Neither host says so in its list, so each request is
// asked about once: GitHub's timeline has a `review_requested` event naming who asked whom; a
// GitLab merge request has a system note, "requested review from @user", written by whoever
// asked. The answer is kept for as long as the request has not changed, so a poll that finds
// nothing new asks nothing. A request whose requester cannot be found has none, and its row names
// its author instead (shared/review-requests.ts `askedBy`). The runner is injected.
import { homedir } from 'node:os';
import { execRunner, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { reviewRequestKey, type FoundReviewRequest } from '../shared/review-requests.ts';

type Fields = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const githubUserArgs = (): string[] => ['api', 'user'];
export const githubTimelineArgs = (repository: string, number: number): string[] => ['api', '-X', 'GET', `repos/${repository}/issues/${number}/timeline`, '-F', 'per_page=100'];

/** Who last asked `login` to review, from a pull request's timeline; null when nobody did by name. Pure. */
export function githubRequester(json: string, login: string): string | null {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return null;
  const asked = parsed.filter(isFields).filter((e) => e.event === 'review_requested' && isFields(e.requested_reviewer) && sameUser(text(e.requested_reviewer.login), login));
  const last = asked.at(-1);
  const by = last && isFields(last.review_requester) ? text(last.review_requester.login) : '';
  return by || null;
}

export const gitlabNotesArgs = (host: string, repository: string, number: number): string[] => [
  'api',
  `projects/${encodeURIComponent(repository)}/merge_requests/${number}/notes?sort=desc&order_by=created_at&per_page=100`,
  '--hostname',
  host,
];

/** Who last asked `username` to review, from a merge request's notes (newest first); null when no note says so. Pure. */
export function gitlabRequester(json: string, username: string): string | null {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return null;
  const mention = new RegExp(`requested review from\\b.*@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'i');
  const note = parsed.filter(isFields).find((n) => n.system === true && mention.test(text(n.body)));
  const by = note && isFields(note.author) ? text(note.author.username) : '';
  return by || null;
}

/** Finds who asked for one request; null when the host does not say. May throw: then it is asked again next time. */
export type FindRequester = (request: FoundReviewRequest) => Promise<string | null>;

/** Asked of gh: who the user is (once), then the request's timeline. */
export function githubFindRequester(run: CommandRunner = execRunner, cwd: string = homedir()): FindRequester {
  let login: string | null = null;
  return async (request) => {
    if (!login) {
      const parsed: unknown = JSON.parse((await run('gh', githubUserArgs(), { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout);
      login = isFields(parsed) ? text(parsed.login) : '';
      if (!login) throw new Error('gh did not say who is signed in');
    }
    return githubRequester((await run('gh', githubTimelineArgs(request.repository, request.number), { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout, login);
  };
}

/** Asked of glab: the request's notes, read for the user this server knows them as. */
export function gitlabFindRequester(usernameOn: (host: string) => string | undefined, run: CommandRunner = execRunner, cwd: string = homedir()): FindRequester {
  return async (request) => {
    const username = usernameOn(request.hostName);
    if (!username) return null;
    return gitlabRequester((await run('glab', gitlabNotesArgs(request.hostName, request.repository, request.number), { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout, username);
  };
}

/**
 * Adds `requestedBy` to each request, asking only about the ones not seen before or changed since.
 * What is kept is dropped with its request, so the cache never outgrows the list.
 */
export function withRequesters(find: FindRequester): (requests: readonly FoundReviewRequest[]) => Promise<FoundReviewRequest[]> {
  let known: ReadonlyMap<string, string | null> = new Map();
  const stamp = (r: FoundReviewRequest): string => `${reviewRequestKey(r)}@${r.updatedAt}`;
  return async (requests) => {
    const found = await Promise.all(
      requests.map(async (request): Promise<[string, string | null] | null> => {
        const key = stamp(request);
        if (known.has(key)) return [key, known.get(key)!];
        try {
          return [key, await find(request)];
        } catch {
          return null; // not kept: asked again on the next poll
        }
      }),
    );
    known = new Map(found.filter((entry): entry is [string, string | null] => entry !== null));
    return requests.map((request) => {
      const by = known.get(stamp(request));
      return by ? { ...request, requestedBy: by } : request;
    });
  };
}
