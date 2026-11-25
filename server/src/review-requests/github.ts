// The pull requests GitHub says the user was asked to review, through `gh api` ("borrow, do not
// build"): one search covers every repository. The qualifier is `user-review-requested`, a request
// made of the user by name; `review-requested` also matches every request made of a team they are
// in, which is hundreds a day for some people (Matt, 2026-11-20). Drafts and archived repositories
// are left out. The runner is injected: tests never call gh.
import { homedir } from 'node:os';
import { execRunner, ghFailureReason, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { FoundReviewRequest } from '../shared/review-requests.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { githubFindOthers, withOthers } from './others.ts';
import { githubFindRequester, withRequesters } from './requester.ts';

export const GITHUB_HOST = 'github.com';
export const GITHUB_REVIEW_QUERY = 'is:pr is:open user-review-requested:@me archived:false draft:false';
/** The most one ask brings back. More than this waiting on one person is not a list anyone reads. */
export const REVIEW_REQUEST_LIMIT = 100;

export const githubReviewArgs = (): string[] => ['api', '-X', 'GET', 'search/issues', '-f', `q=${GITHUB_REVIEW_QUERY}`, '-F', `per_page=${REVIEW_REQUEST_LIMIT}`];

type Fields = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;

/** "owner/name" from an item's `repository_url` (".../repos/owner/name"), or null. Pure. */
export function repositoryOfUrl(url: unknown): string | null {
  const found = /\/repos\/([^/]+\/[^/]+)$/.exec(text(url));
  return found ? found[1]! : null;
}

/** One search item as a request; null when it is not one Kestrel can name. Pure. */
export function mapGithubItem(item: Fields): FoundReviewRequest | null {
  const repository = repositoryOfUrl(item.repository_url);
  if (!repository || typeof item.number !== 'number' || item.draft === true) return null;
  const body = text(item.body);
  return {
    host: 'github',
    hostName: GITHUB_HOST,
    repository,
    number: item.number,
    title: text(item.title) || `#${item.number}`,
    author: isFields(item.user) ? text(item.user.login) : '',
    url: /^https:\/\//.test(text(item.html_url)) ? text(item.html_url) : '',
    updatedAt: Date.parse(text(item.updated_at)) || 0,
    ...(Date.parse(text(item.created_at)) ? { openedAt: Date.parse(text(item.created_at)) } : {}),
    ...(body ? { body } : {}),
  };
}

/** The search's answer as requests. Throws when it is not a search result. Pure. */
export function mapGithubSearch(json: string): FoundReviewRequest[] {
  const parsed: unknown = JSON.parse(json);
  if (!isFields(parsed) || !Array.isArray(parsed.items)) throw new Error('gh did not answer with a search result');
  return parsed.items.filter(isFields).flatMap((item) => mapGithubItem(item) ?? []);
}

export type ReviewRequestLookup = () => Promise<Sourced<FoundReviewRequest[]>>;

export function githubReviewRequests(run: CommandRunner = execRunner, cwd: string = homedir()): ReviewRequestLookup {
  const requesters = withRequesters(githubFindRequester(run, cwd));
  const others = withOthers(githubFindOthers(run, cwd));
  return async () => {
    try {
      const { stdout } = await run('gh', githubReviewArgs(), { cwd, timeoutMs: GH_TIMEOUT_MS });
      return ready(await others(await requesters(mapGithubSearch(stdout))));
    } catch (error) {
      return unavailable(ghFailureReason(error));
    }
  };
}
