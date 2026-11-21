// One request by number through gh and glab (by-number.ts), with a recorded command runner: the
// arguments asked for, the mapping shared with the branch lookups, "no such request" told apart from
// "could not ask". Never calls the real gh or glab.
import { describe, expect, it } from 'vitest';
import { ready } from '../shared/sourced.ts';
import { ghViewArgs, githubByNumber, gitlabByNumber } from './by-number.ts';
import { GH_FIELDS } from './github.ts';
import type { CommandRunner } from './types.ts';

type Outcome = { stdout: string } | { error: object };

function recorded(outcome: Outcome) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const run: CommandRunner = async (command, args, { cwd }) => {
    calls.push({ command, args, cwd });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  };
  return { run, calls };
}

const GH_PR = { number: 7, title: 'Earlier work', state: 'MERGED', isDraft: false, url: 'https://github.com/o/r/pull/7', reviewDecision: 'APPROVED', statusCheckRollup: [], headRefName: 'feat/old' };
const GLAB_MR = { iid: 12, title: 'Earlier MR', state: 'opened', draft: false, web_url: 'https://gitlab.example/o/r/-/merge_requests/12', detailed_merge_status: 'mergeable', head_pipeline: { status: 'failed' }, source_branch: 'feat/old' };

describe('githubByNumber', () => {
  it('asks gh pr view for the number with the list fields, in the repository', async () => {
    const gh = recorded({ stdout: JSON.stringify(GH_PR) });
    const found = await githubByNumber(gh.run).pullRequestByNumber('/repo', 7);
    expect(gh.calls).toEqual([{ command: 'gh', args: ['pr', 'view', '7', '--json', GH_FIELDS], cwd: '/repo' }]);
    expect(ghViewArgs(7)).toEqual(gh.calls[0]!.args);
    expect(found).toMatchObject(ready({ number: 7, state: 'merged', review: 'approved', headBranch: 'feat/old' }));
  });

  it('answers null when GitHub has no such pull request, and a reason when gh cannot be asked', async () => {
    const missing = recorded({ error: { stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)' } });
    expect(await githubByNumber(missing.run).pullRequestByNumber('/repo', 7)).toEqual(ready(null));
    const signedOut = recorded({ error: { stderr: 'To get started with GitHub CLI, please run:  gh auth login' } });
    expect(await githubByNumber(signedOut.run).pullRequestByNumber('/repo', 7)).toEqual({ state: 'unavailable', reason: expect.stringMatching(/not signed in/) });
  });

  it('says when gh answers with something that is not a pull request', async () => {
    const odd = recorded({ stdout: '[]' });
    expect(await githubByNumber(odd.run).pullRequestByNumber('/repo', 7)).toEqual({ state: 'unavailable', reason: expect.stringMatching(/cannot read/) });
  });
});

describe('gitlabByNumber', () => {
  it('asks glab mr view for the iid and maps it as the branch lookup does', async () => {
    const glab = recorded({ stdout: JSON.stringify(GLAB_MR) });
    const found = await gitlabByNumber(glab.run).pullRequestByNumber('/repo', 12);
    expect(glab.calls).toEqual([{ command: 'glab', args: ['mr', 'view', '12', '--output', 'json'], cwd: '/repo' }]);
    expect(found).toMatchObject(ready({ number: 12, state: 'open', checks: 'failing', readiness: 'ready', headBranch: 'feat/old' }));
  });

  it('answers null on a 404 and a reason for any other failure', async () => {
    const missing = recorded({ error: { stderr: 'ERROR: 404 Not Found' } });
    expect(await gitlabByNumber(missing.run).pullRequestByNumber('/repo', 12)).toEqual(ready(null));
    const absent = recorded({ error: { code: 'ENOENT' } });
    expect(await gitlabByNumber(absent.run).pullRequestByNumber('/repo', 12)).toEqual({ state: 'unavailable', reason: expect.stringMatching(/not installed/) });
    const odd = recorded({ stdout: '{"title":"no iid"}' });
    expect(await gitlabByNumber(odd.run).pullRequestByNumber('/repo', 12)).toEqual({ state: 'unavailable', reason: expect.stringMatching(/cannot read/) });
  });
});
