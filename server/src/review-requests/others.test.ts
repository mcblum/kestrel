// What other reviewers said, read from GitHub and GitLab (others.ts), and how answers are kept. The
// runner is a stand-in: nothing here calls a host.
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { FoundReviewRequest } from '../shared/review-requests.ts';
import { githubFindOthers, githubOthers, githubOthersArgs, gitlabFindOthers, gitlabOthers, OTHERS_FRESH_MS, withOthers } from './others.ts';

const github = (reviewDecision: string | null, reviews: { state: string; login: string }[], viewer = 'matt') =>
  JSON.stringify({ data: { viewer: { login: viewer }, repository: { pullRequest: { reviewDecision, latestOpinionatedReviews: { nodes: reviews.map((r) => ({ state: r.state, author: { login: r.login } })) } } } } });

describe('GitHub', () => {
  it('asks one GraphQL question for the decision and each reviewer’s latest review', () => {
    const args = githubOthersArgs('acme/app', 12);
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('owner=acme');
    expect(args).toContain('name=app');
    expect(args).toContain('number=12');
    expect(args.find((a) => a.startsWith('query='))).toContain('latestOpinionatedReviews');
  });

  it('counts approvals and requests for changes, not a dismissed review, and not the user’s own', () => {
    const answer = github('REVIEW_REQUIRED', [
      { state: 'APPROVED', login: 'dana' },
      { state: 'DISMISSED', login: 'lee' },
      { state: 'CHANGES_REQUESTED', login: 'kim' },
      { state: 'APPROVED', login: 'matt' },
    ]);
    expect(githubOthers(answer)).toEqual({ approvedBy: ['dana'], changesRequestedBy: ['kim'], satisfied: false });
  });

  it('is satisfied only when the review decision is APPROVED; no required reviews is never satisfied', () => {
    expect(githubOthers(github('APPROVED', [{ state: 'APPROVED', login: 'dana' }])).satisfied).toBe(true);
    expect(githubOthers(github(null, [{ state: 'APPROVED', login: 'dana' }])).satisfied).toBe(false);
  });

  it('throws when the answer is not about a pull request', () => {
    expect(() => githubOthers(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toThrow();
    expect(() => githubOthers(JSON.stringify({ errors: [{ message: 'nope' }] }))).toThrow();
  });

  it('runs gh for the request', async () => {
    const asked: string[][] = [];
    const run: CommandRunner = async (bin, args) => (asked.push([bin, ...args]), { stdout: github('APPROVED', []) });
    const found = await githubFindOthers(run, '/')(sample());
    expect(found.satisfied).toBe(true);
    expect(asked[0]?.[0]).toBe('gh');
  });
});

describe('GitLab', () => {
  const approvals = (required: number, left: number, by: string[]) => JSON.stringify({ approved: left === 0, approvals_required: required, approvals_left: left, approved_by: by.map((username) => ({ user: { username } })) });
  const reviewers = (states: [string, string][]) => JSON.stringify(states.map(([username, state]) => ({ user: { username }, state })));

  it('reads who approved and who asked for changes, without the user', () => {
    expect(gitlabOthers(approvals(2, 1, ['dana', 'matt']), reviewers([['kim', 'requested_changes'], ['dana', 'approved'], ['lee', 'unreviewed']]), 'matt')).toEqual({ approvedBy: ['dana'], changesRequestedBy: ['kim'], satisfied: false });
  });

  it('is satisfied when a rule requires approvals and none are left; never with no rule', () => {
    expect(gitlabOthers(approvals(1, 0, ['dana']), null, 'matt').satisfied).toBe(true);
    expect(gitlabOthers(approvals(0, 0, ['dana']), null, 'matt').satisfied).toBe(false);
  });

  it('takes nobody to have asked for changes when the reviewers cannot be read', async () => {
    const run: CommandRunner = async (_bin, args) => {
      if (args[1]!.endsWith('/reviewers')) throw new Error('404');
      return { stdout: approvals(1, 1, []) };
    };
    expect(await gitlabFindOthers(() => 'matt', run, '/')(sample({ host: 'gitlab', hostName: 'git.example.io' }))).toEqual({ approvedBy: [], changesRequestedBy: [], satisfied: false });
  });
});

function sample(over: Partial<FoundReviewRequest> = {}): FoundReviewRequest {
  return { host: 'github', hostName: 'github.com', repository: 'acme/app', number: 12, title: 'T', author: 'sam', url: '', updatedAt: 100, ...over };
}

describe('keeping answers', () => {
  const SAID = { approvedBy: ['dana'], changesRequestedBy: [], satisfied: true };

  it('asks once while the request is unchanged, again when it changes or the answer grows old', async () => {
    let asks = 0;
    let now = 0;
    const add = withOthers(async () => (asks++, SAID), () => now);
    expect((await add([sample()]))[0]?.others).toEqual(SAID);
    await add([sample()]);
    expect(asks).toBe(1);
    await add([sample({ updatedAt: 200 })]);
    expect(asks).toBe(2);
    now = OTHERS_FRESH_MS;
    await add([sample({ updatedAt: 200 })]);
    expect(asks).toBe(3);
  });

  it('keeps the last answer when a question fails, and lists the request without one when there is none', async () => {
    let fail = false;
    let now = 0;
    const add = withOthers(async () => {
      if (fail) throw new Error('down');
      return SAID;
    }, () => now);
    fail = true;
    expect((await add([sample()]))[0]?.others).toBeUndefined();
    fail = false;
    await add([sample()]);
    fail = true;
    now = OTHERS_FRESH_MS + 1;
    expect((await add([sample({ updatedAt: 300 })]))[0]?.others).toEqual(SAID);
  });
});
