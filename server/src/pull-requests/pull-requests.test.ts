import { describe, expect, it } from 'vitest';
import type { PullRequest, PullRequestLookup } from '../shared/details.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { chooseProvider, hostNeedingGlab, pullRequestsFor, remoteHost, type PullRequestSources } from './choose.ts';
import { connectHint, type GlabSignIn } from './glab.ts';
import { samplePullRequests } from './fake.ts';
import { checksOf, commitPipelineOf, githubProvider, githubReadiness, mapGhItem, mapGhPullRequests } from './github.ts';
import type { CommandRunner, PullRequestProvider } from './types.ts';

describe('choosing a provider by the origin remote', () => {
  it('reads the host from https, ssh and scp-like URLs; a local path has none', () => {
    expect(remoteHost('https://github.com/o/r.git')).toBe('github.com');
    expect(remoteHost('git@github.com:o/r.git')).toBe('github.com');
    expect(remoteHost('ssh://git@starfish.example.io:2222/o/r.git')).toBe('starfish.example.io');
    expect(remoteHost('/Users/me/repos/r.git')).toBeNull();
    expect(remoteHost('../r')).toBeNull();
  });
  it('uses gh for GitHub and says plainly when there is no remote or no connection', () => {
    expect(chooseProvider('git@github.com:o/r.git')).toEqual({ kind: 'github' });
    expect(chooseProvider(null)).toEqual({ kind: 'none', reason: 'This repository has no remote' });
    expect(chooseProvider('https://gitlab.example.io/o/r.git')).toEqual({ kind: 'none', reason: 'No connection to gitlab.example.io yet' });
    expect(chooseProvider('/srv/r.git')).toMatchObject({ kind: 'none' });
  });
  it('uses glab for any other host glab is signed in to, whatever the host is called', () => {
    expect(chooseProvider('git@starfish.example.io:devops/r.git', { signedIn: true })).toEqual({ kind: 'gitlab', host: 'starfish.example.io' });
    expect(chooseProvider('https://gitlab.com/o/r.git', { signedIn: true })).toEqual({ kind: 'gitlab', host: 'gitlab.com' });
    expect(chooseProvider('https://gitlab.com/o/r.git', { signedIn: false, reason: connectHint('gitlab.com') })).toEqual({ kind: 'none', reason: 'Install glab and run `glab auth login --hostname gitlab.com` to connect merge requests' });
    // A GitHub remote never asks glab, even when it would say yes.
    expect(chooseProvider('https://github.com/o/r', { signedIn: true })).toEqual({ kind: 'github' });
    expect(hostNeedingGlab('https://github.com/o/r')).toBeNull();
    expect(hostNeedingGlab('ssh://git@starfish.example.io:2222/o/r.git')).toBe('starfish.example.io');
  });
  it('asks the provider the remote calls for, and says which kind of host answered', async () => {
    const asked: string[] = [];
    const provider = (name: string): PullRequestProvider => ({ pullRequestsFor: async (_r, b) => (asked.push(`${name}:${b}`), ready([])) });
    const glabAsked: string[] = [];
    const glabSignIn = async (host: string): Promise<GlabSignIn> => (glabAsked.push(host), host === 'starfish.example.io' ? { signedIn: true } : { signedIn: false, reason: connectHint(host) });
    const sources = (origin: string | null): PullRequestSources => ({ github: provider('gh'), gitlab: provider('glab'), glabSignIn, originOf: async () => origin });
    expect(await pullRequestsFor(sources('https://github.com/o/r'), '/r', 'feat/x')).toEqual(ready({ host: 'github', pullRequests: [] }));
    expect(await pullRequestsFor(sources('git@starfish.example.io:o/r.git'), '/r', 'feat/x')).toEqual(ready({ host: 'gitlab', pullRequests: [] }));
    expect(await pullRequestsFor(sources('https://gitlab.com/o/r'), '/r', 'feat/x')).toEqual(unavailable(connectHint('gitlab.com')));
    expect(await pullRequestsFor(sources(null), '/r', 'feat/x')).toEqual(unavailable('This repository has no remote'));
    expect(asked).toEqual(['gh:feat/x', 'glab:feat/x']);
    expect(glabAsked).toEqual(['starfish.example.io', 'gitlab.com']);
  });
});

const GH_JSON = JSON.stringify([
  { number: 12, title: 'Add search', state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/12', reviewDecision: 'APPROVED', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }] },
  { number: 11, title: 'Draft it', state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/11', reviewDecision: '', statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }] },
  { number: 10, title: 'Old', state: 'MERGED', isDraft: false, url: 'https://github.com/o/r/pull/10', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'StatusContext', state: 'PENDING' }] },
  { number: 9, title: 'Gone', state: 'CLOSED', isDraft: false, url: 'javascript:alert(1)', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] },
]);

describe('gh pr list output', () => {
  it('maps state, draft, checks and review', () => {
    expect(mapGhPullRequests(GH_JSON)).toEqual<PullRequest[]>([
      { number: 12, title: 'Add search', state: 'open', checks: 'passing', review: 'approved', checksUrl: 'https://github.com/o/r/pull/12/checks', url: 'https://github.com/o/r/pull/12' },
      { number: 11, title: 'Draft it', state: 'draft', checks: 'running', review: 'none', checksUrl: 'https://github.com/o/r/pull/11/checks', url: 'https://github.com/o/r/pull/11' },
      { number: 10, title: 'Old', state: 'merged', checks: 'failing', review: 'changes-requested', checksUrl: 'https://github.com/o/r/pull/10/checks', url: 'https://github.com/o/r/pull/10' },
      { number: 9, title: 'Gone', state: 'closed', checks: 'none', review: 'review-required', url: '' },
    ]);
  });
  it('maps GitHub’s merge state onto the neutral readiness, ready only when CLEAN and MERGEABLE', () => {
    expect(githubReadiness('CLEAN', 'MERGEABLE')).toBe('ready');
    expect(githubReadiness('CLEAN', 'UNKNOWN')).toBe('unknown');
    expect(githubReadiness('DIRTY', 'MERGEABLE')).toBe('conflicts');
    expect(githubReadiness('BLOCKED', 'CONFLICTING')).toBe('conflicts');
    expect(githubReadiness('BEHIND', 'MERGEABLE')).toBe('behind');
    expect(githubReadiness('BLOCKED', 'MERGEABLE')).toBe('blocked');
    expect(githubReadiness('UNSTABLE', 'MERGEABLE')).toBe('unknown');
    const [mapped] = mapGhPullRequests(JSON.stringify([{ number: 1, title: 't', state: 'OPEN', url: 'https://github.com/o/r/pull/1', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' }]));
    expect(mapped!.readiness).toBe('ready');
  });
  it('treats a pending status context as running and no checks as none', () => {
    expect(checksOf([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('running');
    expect(checksOf(null)).toBe('none');
  });
  it('refuses an answer that is not a list', () => {
    expect(() => mapGhPullRequests('{"message":"x"}')).toThrow(/list/);
  });
});

/** A gh stand-in: answers with `stdout` or rejects with `error`, and records what it was asked. */
function fakeGh(outcome: { stdout: string } | { error: object }) {
  const calls: { command: string; args: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, ...options });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  };
  return { runner, calls };
}

describe('the GitHub provider', () => {
  it('runs gh with an argument list in the repository, with a timeout', async () => {
    const gh = fakeGh({ stdout: '[]' });
    expect(await githubProvider(gh.runner).pullRequestsFor('/repo', 'feat/x')).toEqual(ready([]));
    expect(gh.calls).toEqual([{ command: 'gh', args: ['pr', 'list', '--head=feat/x', '--state', 'all', '--json', 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup,body,author,headRefName,baseRefName,mergeStateStatus,mergeable,headRefOid,latestReviews,mergeCommit'], cwd: '/repo', timeoutMs: 10_000 }]);
  });
  it('says when gh is missing, not signed in, too slow, or answers nonsense', async () => {
    const ask = async (outcome: { stdout: string } | { error: object }) => githubProvider(fakeGh(outcome).runner).pullRequestsFor('/repo', 'b');
    expect(await ask({ error: { code: 'ENOENT' } })).toEqual(unavailable('The gh command is not installed (or not on Kestrel’s PATH)'));
    expect(await ask({ error: { code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } })).toEqual(unavailable('gh is not signed in to GitHub (run gh auth login)'));
    expect(await ask({ error: { killed: true } })).toEqual(unavailable('gh did not answer within 10 seconds'));
    expect(await ask({ stdout: 'not json' })).toMatchObject({ state: 'unavailable' });
  });
});

describe('the target branch after a merge (Autopilot\'s watch)', () => {
  const SHA = 'a'.repeat(40);
  it('a merged request names the commit its merge made; an open one does not', () => {
    expect(mapGhItem({ number: 7, state: 'MERGED', mergeCommit: { oid: SHA } }).mergeSha).toBe(SHA);
    expect(mapGhItem({ number: 7, state: 'OPEN', mergeCommit: null }).mergeSha).toBeUndefined();
  });

  it('reads the commit\'s check runs and statuses as the request\'s checks are read', () => {
    const runs = (items: object[]) => JSON.stringify({ total_count: items.length, check_runs: items });
    const status = (items: object[]) => JSON.stringify({ state: 'pending', statuses: items });
    expect(commitPipelineOf(SHA, runs([]), status([]))).toEqual({ sha: SHA, checks: 'none' });
    expect(commitPipelineOf(SHA, runs([{ name: 'build', status: 'in_progress', conclusion: null }]), status([])).checks).toBe('running');
    expect(commitPipelineOf(SHA, runs([{ name: 'build', status: 'completed', conclusion: 'success' }]), status([{ context: 'ci/jenkins', state: 'success' }])).checks).toBe('passing');
    expect(commitPipelineOf(SHA, runs([{ name: 'test', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/o/r/actions/runs/1/job/2' }]), status([{ context: 'ci/jenkins', state: 'error', target_url: 'https://ci.example.com/1' }]))).toEqual({
      sha: SHA,
      checks: 'failing',
      failedChecks: [
        { name: 'test', url: 'https://github.com/o/r/actions/runs/1/job/2' },
        { name: 'ci/jenkins', url: 'https://ci.example.com/1' },
      ],
    });
    expect(() => commitPipelineOf(SHA, '{}', '{}')).toThrow(/check runs and statuses/);
  });

  it('asks gh for both, in the repository, and refuses what is not a commit', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args.join(' '));
      return { stdout: args[1]!.includes('check-runs') ? JSON.stringify({ check_runs: [] }) : JSON.stringify({ statuses: [] }) };
    };
    expect(await githubProvider(runner).pipelineOn('/repo', SHA, 'main')).toEqual(ready({ sha: SHA, checks: 'none' }));
    expect(calls).toEqual([`api repos/{owner}/{repo}/commits/${SHA}/check-runs?per_page=100`, `api repos/{owner}/{repo}/commits/${SHA}/status`]);
    expect(await githubProvider(runner).pipelineOn('/repo', 'main; rm -rf', 'main')).toMatchObject({ state: 'unavailable' });
  });
});

const found = (pullRequests: PullRequest[]) => ready<PullRequestLookup>({ host: 'github', pullRequests });

describe('the sample provider (fake store only)', () => {
  it('has one open pull request with running checks, two (draft and merged) for another branch, none elsewhere', async () => {
    const sampleProvider = samplePullRequests();
    const one = await sampleProvider.pullRequestsFor('', 'feat/instant-search');
    expect(one.state === 'ready' && one.value.map((p) => [p.state, p.checks])).toEqual([['open', 'running']]);
    const two = await sampleProvider.pullRequestsFor('', 'feat/shortcuts');
    expect(two.state === 'ready' && two.value.map((p) => p.state)).toEqual(['draft', 'merged']);
    expect(await sampleProvider.pullRequestsFor('', 'main')).toEqual(ready([]));
  });

  it('makes up an open pull request for a branch with none, once, and keeps it to its own provider', async () => {
    const samples = samplePullRequests();
    const form = { title: 'Polish auth', body: 'Body', base: 'main', draft: false };
    const made = samples.create('feat/auth-polish', form);
    expect(made).toMatchObject({ number: 501, state: 'open', title: 'Polish auth', headBranch: 'feat/auth-polish', baseBranch: 'main', url: 'https://github.com/example/sample/pull/501' });
    expect(samples.create('feat/auth-polish', { ...form, title: 'Again' })).toBe(made);
    expect(samples.create('feat/other', { ...form, draft: true })).toMatchObject({ number: 502, state: 'draft' });
    expect(await samples.pullRequestsFor('', 'feat/auth-polish')).toEqual(ready([made]));
    expect(await samplePullRequests().pullRequestsFor('', 'feat/auth-polish')).toEqual(ready([]));
  });
});
