// What other reviewers have already said on each request (shared/others-said.ts), read from the
// host with the rest of the list, so nothing asks gh or glab per view. Neither host's list says it,
// so each request is asked about, as for who asked (requester.ts), and the answer kept while the
// request has not changed, and for at most OTHERS_FRESH_MS: an approval that does not change a
// request's `updated_at` is still seen within that.
//
//   - GitHub: one GraphQL question per request: the review decision (APPROVED only when branch
//     protection requires reviews and they are given) and each reviewer's latest opinionated review
//     (`latestOpinionatedReviews`), so a review dismissed after a push reads as DISMISSED and does
//     not count.
//   - GitLab: the merge request's approvals (who, and how many are left of how many required) and
//     its reviewers' states (`requested_changes`). An approval GitLab resets on a push is gone from
//     `approved_by`.
//
// The user's own review is never "someone else's": their login is left out. A failed question is
// asked again on the next poll; meanwhile the last answer stands, or the request is listed without one.
// The runner is injected: tests never call gh or glab.
import { homedir } from 'node:os';
import { execRunner, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { othersOnly, type OthersReviews } from '../shared/others-said.ts';
import { reviewRequestKey, type FoundReviewRequest } from '../shared/review-requests.ts';

/** How long an answer is kept for a request that has not changed. */
export const OTHERS_FRESH_MS = 15 * 60_000;

type Fields = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const list = (value: unknown): Fields[] => (Array.isArray(value) ? value.filter(isFields) : []);

export const GITHUB_OTHERS_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewDecision latestOpinionatedReviews(first: 100) { nodes { state author { login } } } } } }';

export function githubOthersArgs(repository: string, number: number): string[] {
  const [owner = '', name = ''] = repository.split('/');
  return ['api', 'graphql', '-f', `query=${GITHUB_OTHERS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`];
}

/** GitHub's answer as what others said. Throws when it is not an answer about a pull request. Pure. */
export function githubOthers(json: string): OthersReviews {
  const parsed: unknown = JSON.parse(json);
  const data = isFields(parsed) && isFields(parsed.data) ? parsed.data : null;
  const pull = data && isFields(data.repository) && isFields(data.repository.pullRequest) ? data.repository.pullRequest : null;
  if (!data || !pull) throw new Error('gh did not answer with the pull request');
  const me = isFields(data.viewer) ? text(data.viewer.login) : '';
  const reviews = isFields(pull.latestOpinionatedReviews) ? list(pull.latestOpinionatedReviews.nodes) : [];
  const by = (state: string): string[] => othersOnly(reviews.filter((r) => r.state === state).map((r) => (isFields(r.author) ? text(r.author.login) : '')), me);
  return { approvedBy: by('APPROVED'), changesRequestedBy: by('CHANGES_REQUESTED'), satisfied: pull.reviewDecision === 'APPROVED' };
}

const gitlabRequest = (repository: string, number: number): string => `projects/${encodeURIComponent(repository)}/merge_requests/${number}`;
export const gitlabApprovalsArgs = (host: string, repository: string, number: number): string[] => ['api', `${gitlabRequest(repository, number)}/approvals`, '--hostname', host];
export const gitlabReviewersArgs = (host: string, repository: string, number: number): string[] => ['api', `${gitlabRequest(repository, number)}/reviewers`, '--hostname', host];

const username = (entry: Fields): string => (isFields(entry.user) ? text(entry.user.username) : '');

/**
 * GitLab's answers as what others said: the approvals, and the reviewers' states (null when that
 * could not be read: an older GitLab, then nobody is taken to have asked for changes). Satisfied
 * needs an approval rule: a merge request that requires none is never satisfied. Throws when the
 * approvals are not an answer. Pure.
 */
export function gitlabOthers(approvalsJson: string, reviewersJson: string | null, me: string): OthersReviews {
  const approvals: unknown = JSON.parse(approvalsJson);
  if (!isFields(approvals)) throw new Error('glab did not answer with the approvals');
  const required = typeof approvals.approvals_required === 'number' ? approvals.approvals_required : 0;
  const left = typeof approvals.approvals_left === 'number' ? approvals.approvals_left : null;
  const reviewers: unknown = reviewersJson === null ? [] : JSON.parse(reviewersJson);
  return {
    approvedBy: othersOnly(list(approvals.approved_by).map(username), me),
    changesRequestedBy: othersOnly(list(reviewers).filter((r) => r.state === 'requested_changes').map(username), me),
    satisfied: required > 0 && left === 0,
  };
}

/** Finds what others said on one request. May throw: then it is asked again next time. */
export type FindOthers = (request: FoundReviewRequest) => Promise<OthersReviews>;

export function githubFindOthers(run: CommandRunner = execRunner, cwd: string = homedir()): FindOthers {
  return async (request) => githubOthers((await run('gh', githubOthersArgs(request.repository, request.number), { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout);
}

export function gitlabFindOthers(usernameOn: (host: string) => string | undefined, run: CommandRunner = execRunner, cwd: string = homedir()): FindOthers {
  return async (request) => {
    const glab = async (args: string[]) => (await run('glab', args, { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout;
    const [approvals, reviewers] = await Promise.all([
      glab(gitlabApprovalsArgs(request.hostName, request.repository, request.number)),
      glab(gitlabReviewersArgs(request.hostName, request.repository, request.number)).catch(() => null),
    ]);
    return gitlabOthers(approvals, reviewers, usernameOn(request.hostName) ?? '');
  };
}

interface Kept {
  stamp: string;
  at: number;
  others: OthersReviews;
}

/**
 * Adds `others` to each request, asking only about the ones not seen before, changed since, or
 * asked about more than OTHERS_FRESH_MS ago. What is kept is dropped with its request.
 */
export function withOthers(find: FindOthers, now: () => number = Date.now): (requests: readonly FoundReviewRequest[]) => Promise<FoundReviewRequest[]> {
  let known: ReadonlyMap<string, Kept> = new Map();
  return async (requests) => {
    const at = now();
    const found = await Promise.all(
      requests.map(async (request): Promise<[string, Kept] | null> => {
        const key = reviewRequestKey(request);
        const stamp = String(request.updatedAt);
        const held = known.get(key);
        if (held && held.stamp === stamp && at - held.at < OTHERS_FRESH_MS) return [key, held];
        try {
          return [key, { stamp, at, others: await find(request) }];
        } catch {
          // Asked again on the next poll; meanwhile the last answer stands, so a host that fails
          // for a moment does not make a satisfied request look unsatisfied.
          return held ? [key, held] : null;
        }
      }),
    );
    known = new Map(found.filter((entry): entry is [string, Kept] => entry !== null));
    return requests.map((request) => {
      const kept = known.get(reviewRequestKey(request));
      return kept ? { ...request, others: kept.others } : request;
    });
  };
}
