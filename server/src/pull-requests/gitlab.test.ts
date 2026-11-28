// GitLab merge requests through glab: the sign-in check (cached per host, failures too), the mapping
// from GitLab's API objects, the lookup with its exact glab arguments, and creating one through the
// shared flow (preparePR, publishPR). Every command goes to a stand-in runner: glab, git push and a
// model are never run.
import { describe, expect, it } from 'vitest';
import { ready, unavailable } from '../shared/sourced.ts';
import { preparePR, publishPR } from './create.ts';
import { gitlabCommands, gitlabProvider, gitlabReadiness, gitlabReview, glabCreatedUrl, mapGlabMergeRequest, parseGlabList, pipelineChecks, pipelinesArgs } from './gitlab.ts';
import { glabSignInLookup } from './glab.ts';
import type { CommandRunner } from './types.ts';

type Call = { bin: string; args: readonly string[]; cwd: string; timeoutMs: number };

/** A runner that answers from `answers` by "bin arg arg…", records every call, and fails on anything else. */
function fakeRunner(answers: Record<string, string | object>) {
  const calls: Call[] = [];
  const run: CommandRunner = async (bin, args, options) => {
    calls.push({ bin, args, ...options });
    const answer = answers[[bin, ...args].join(' ')];
    if (answer === undefined) throw new Error(`unexpected command: ${bin} ${args.join(' ')}`);
    if (typeof answer !== 'string') throw answer;
    return { stdout: answer };
  };
  return { run, calls };
}

const HOST = 'starfish.example.io';
const WEB = `https://${HOST}/devops/r/-/merge_requests`;
const mr = (iid: number, fields: Record<string, unknown> = {}) => ({
  iid,
  title: `Change ${iid}`,
  state: 'opened',
  draft: false,
  web_url: `${WEB}/${iid}`,
  description: 'Body',
  author: { username: 'mcblum' },
  source_branch: 'feat/x',
  target_branch: 'main',
  has_conflicts: false,
  detailed_merge_status: 'mergeable',
  ...fields,
});

describe('glab sign-in', () => {
  it('asks `glab auth status --hostname <host>` once per host and keeps the answer, failures included', async () => {
    const { run, calls } = fakeRunner({ [`glab auth status --hostname ${HOST}`]: 'Logged in', 'glab auth status --hostname gitlab.com': { code: 1, stderr: 'x gitlab.com: no token' } });
    const check = glabSignInLookup(run, '/home');
    expect(await check(HOST)).toEqual({ signedIn: true });
    expect(await check(HOST)).toEqual({ signedIn: true });
    expect(await check('gitlab.com')).toEqual({ signedIn: false, reason: 'glab is not signed in to gitlab.com: run `glab auth login --hostname gitlab.com` to connect merge requests' });
    expect(await check('gitlab.com')).toMatchObject({ signedIn: false });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['glab', 'auth', 'status', '--hostname', HOST],
      ['glab', 'auth', 'status', '--hostname', 'gitlab.com'],
    ]);
    expect(calls[0]).toMatchObject({ cwd: '/home', timeoutMs: 10_000 });
  });
  it('says to install glab when it is not there', async () => {
    const check = glabSignInLookup(async () => Promise.reject(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })), '/home');
    expect(await check(HOST)).toEqual({ signedIn: false, reason: `Install glab and run \`glab auth login --hostname ${HOST}\` to connect merge requests` });
  });
});

describe('mapping GitLab merge requests', () => {
  it('takes a pipeline of an older commit as no checks on this one yet', () => {
    const OLD = 'a'.repeat(40);
    const NEW = 'b'.repeat(40);
    const failed = { id: 5, status: 'failed', web_url: 'https://gitlab.example.com/g/p/-/pipelines/5' };
    // Just after a push: `sha` is the new commit, `head_pipeline` still the last one's.
    const stale = mapGlabMergeRequest(mr(3, { sha: NEW, head_pipeline: { ...failed, sha: OLD, ref: 'refs/merge-requests/3/head' } }));
    expect(stale.checks).toBe('none');
    expect(stale.checksUrl).toBeUndefined();
    expect(mapGlabMergeRequest(mr(3, { sha: NEW, head_pipeline: { ...failed, sha: NEW, ref: 'refs/merge-requests/3/head' } }))).toMatchObject({ checks: 'failing', checksUrl: failed.web_url });
    // A merged-results pipeline runs on a merge commit of its own: never compared.
    expect(mapGlabMergeRequest(mr(3, { sha: NEW, head_pipeline: { ...failed, sha: OLD, ref: 'refs/merge-requests/3/merge' } })).checks).toBe('failing');
    expect(mapGlabMergeRequest(mr(3, { sha: NEW, head_pipeline: failed })).checks).toBe('failing');
  });
  it('maps each state, a draft, and the fields onto a pull request', () => {
    expect(mapGlabMergeRequest(mr(12))).toEqual({ number: 12, title: 'Change 12', state: 'open', checks: 'none', review: 'none', readiness: 'ready', url: `${WEB}/12`, body: 'Body', author: 'mcblum', headBranch: 'feat/x', baseBranch: 'main' });
    expect(mapGlabMergeRequest(mr(1, { draft: true, detailed_merge_status: 'draft_status' }))).toMatchObject({ state: 'draft', readiness: 'blocked' });
    expect(mapGlabMergeRequest(mr(2, { state: 'merged', detailed_merge_status: 'not_open' }))).toMatchObject({ state: 'merged' });
    expect(mapGlabMergeRequest(mr(2, { state: 'merged', detailed_merge_status: 'not_open' })).readiness).toBeUndefined();
    expect(mapGlabMergeRequest(mr(3, { state: 'closed' }))).toMatchObject({ state: 'closed' });
    expect(mapGlabMergeRequest(mr(4, { state: 'locked' }))).toMatchObject({ state: 'open' });
    expect(mapGlabMergeRequest(mr(5, { web_url: 'javascript:alert(1)', title: 7 }))).toMatchObject({ url: '', title: '!5' });
  });
  it('reads conflicts, behind and blocked from detailed_merge_status; green only on "mergeable"', () => {
    expect(gitlabReadiness('mergeable', false)).toBe('ready');
    expect(gitlabReadiness('mergeable', true)).toBe('conflicts');
    expect(gitlabReadiness('conflict', false)).toBe('conflicts');
    expect(gitlabReadiness('need_rebase', false)).toBe('behind');
    for (const status of ['ci_must_pass', 'ci_still_running', 'discussions_not_resolved', 'draft_status', 'not_approved', 'requested_changes', 'blocked_status']) expect(gitlabReadiness(status, false)).toBe('blocked');
    for (const status of ['checking', 'unchecked', 'not_open', undefined]) expect(gitlabReadiness(status, false)).toBe('unknown');
  });
  it('reads review from detailed_merge_status, with no extra calls for approvals', () => {
    expect(gitlabReview('not_approved')).toBe('review-required');
    expect(gitlabReview('requested_changes')).toBe('changes-requested');
    expect(gitlabReview('mergeable')).toBe('none');
    expect(mapGlabMergeRequest(mr(6, { detailed_merge_status: 'not_approved' }))).toMatchObject({ review: 'review-required', readiness: 'blocked' });
  });
  it('reads the head pipeline as checks', () => {
    expect(pipelineChecks('success')).toBe('passing');
    for (const status of ['failed', 'canceled']) expect(pipelineChecks(status)).toBe('failing');
    for (const status of ['running', 'pending', 'created', 'manual']) expect(pipelineChecks(status)).toBe('running');
    for (const status of ['skipped', undefined, null, '']) expect(pipelineChecks(status)).toBe('none');
    expect(mapGlabMergeRequest(mr(7, { head_pipeline: { status: 'failed' } }))).toMatchObject({ checks: 'failing' });
    expect(mapGlabMergeRequest(mr(7, { head_pipeline: null }))).toMatchObject({ checks: 'none' });
  });
  it('refuses a list answer that is junk, and skips items without an iid', () => {
    expect(() => parseGlabList('{"message":"404 Not Found"}')).toThrow(/list/);
    expect(() => parseGlabList('not json')).toThrow();
    expect(parseGlabList(JSON.stringify([mr(1), { title: 'no iid' }, null, 'x'])).map((m) => m.iid)).toEqual([1]);
  });
});

describe('the GitLab provider', () => {
  const LIST = 'glab mr list --source-branch=feat/x --all --output json';
  it('lists every state for the branch, and views only the open and draft ones for their pipeline', async () => {
    const list = JSON.stringify([mr(12), mr(11, { draft: true, detailed_merge_status: 'draft_status' }), mr(10, { state: 'merged', detailed_merge_status: 'not_open' })]);
    const { run, calls } = fakeRunner({
      [LIST]: list,
      'glab mr view 12 --output json': JSON.stringify(mr(12, { head_pipeline: { status: 'running' }, detailed_merge_status: 'ci_still_running' })),
      'glab mr view 11 --output json': JSON.stringify(mr(11, { draft: true, head_pipeline: { status: 'success' } })),
    });
    const found = await gitlabProvider(run).pullRequestsFor('/repo', 'feat/x');
    expect(found.state === 'ready' && found.value.map((p) => [p.number, p.state, p.checks, p.readiness])).toEqual([
      [12, 'open', 'running', 'blocked'],
      [11, 'draft', 'passing', 'ready'],
      [10, 'merged', 'none', undefined],
    ]);
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['glab', 'mr', 'list', '--source-branch=feat/x', '--all', '--output', 'json'],
      ['glab', 'mr', 'view', '12', '--output', 'json'],
      ['glab', 'mr', 'view', '11', '--output', 'json'],
      // Each open one's reviewers, for a request for changes the merge status may hide.
      ['glab', 'api', 'projects/:id/merge_requests/12/reviewers'],
      ['glab', 'api', 'projects/:id/merge_requests/11/reviewers'],
    ]);
    expect(calls.every((c) => c.cwd === '/repo' && c.timeoutMs === 10_000)).toBe(true);
  });
  it('answers an empty list without viewing anything', async () => {
    const { run, calls } = fakeRunner({ [LIST]: '[]' });
    expect(await gitlabProvider(run).pullRequestsFor('/repo', 'feat/x')).toEqual(ready([]));
    expect(calls).toHaveLength(1);
  });
  it('says why when glab is missing, signed out, or answers nonsense', async () => {
    const ask = (answer: string | object) => gitlabProvider(fakeRunner({ [LIST]: answer }).run).pullRequestsFor('/repo', 'feat/x');
    expect(await ask({ code: 'ENOENT' })).toEqual(unavailable('The glab command is not installed (or not on Kestrel’s PATH)'));
    expect(await ask({ killed: true })).toEqual(unavailable('glab did not answer within 10 seconds'));
    expect(await ask({ code: 1, stderr: 'please run glab auth login' })).toEqual(unavailable('glab is not signed in (run glab auth login)'));
    expect(await ask('{"message":"x"}')).toEqual(unavailable('glab gave an answer Kestrel cannot read: glab did not answer with a list'));
    const badView = fakeRunner({ [LIST]: JSON.stringify([mr(12)]), 'glab mr view 12 --output json': 'nope' });
    expect(await gitlabProvider(badView.run).pullRequestsFor('/repo', 'feat/x')).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/cannot read/) });
  });
});

describe('the target branch after a merge (Autopilot\'s watch)', () => {
  const SHA = 'b'.repeat(40);
  it('a merged one names its merge commit, else its squash commit, else its head', () => {
    expect(mapGlabMergeRequest(mr(1, { state: 'merged', sha: 'h'.repeat(40), merge_commit_sha: SHA, squash_commit_sha: 'c'.repeat(40) })).mergeSha).toBe(SHA);
    expect(mapGlabMergeRequest(mr(1, { state: 'merged', sha: 'h'.repeat(40), merge_commit_sha: null, squash_commit_sha: 'c'.repeat(40) })).mergeSha).toBe('c'.repeat(40));
    expect(mapGlabMergeRequest(mr(1, { state: 'merged', sha: 'h'.repeat(40), merge_commit_sha: null })).mergeSha).toBe('h'.repeat(40));
    expect(mapGlabMergeRequest(mr(1, { sha: 'h'.repeat(40), merge_commit_sha: SHA })).mergeSha).toBeUndefined();
  });

  it('the newest pipeline for the commit on the branch, and a failed one\'s jobs', async () => {
    const { run, calls } = fakeRunner({
      [['glab', ...pipelinesArgs(SHA, 'main')].join(' ')]: JSON.stringify([
        { id: 40, status: 'success', sha: SHA, ref: 'main' },
        { id: 41, status: 'failed', sha: SHA, ref: 'main', updated_at: 't', web_url: `https://${HOST}/devops/r/-/pipelines/41` },
      ]),
      'glab api projects/:id/pipelines/41/jobs?scope[]=failed&per_page=100': JSON.stringify([{ name: 'test', web_url: `https://${HOST}/devops/r/-/jobs/9` }]),
      [`glab api projects/:id/repository/commits/${SHA}/statuses?per_page=100`]: '[]',
    });
    expect(await gitlabProvider(run).pipelineOn('/repo', SHA, 'main')).toEqual(ready({ sha: SHA, checks: 'failing', failedChecks: [{ name: 'test', url: `https://${HOST}/devops/r/-/jobs/9` }], url: `https://${HOST}/devops/r/-/pipelines/41` }));
    expect(calls[0]!.args).toEqual(['api', `projects/:id/pipelines?sha=${SHA}&ref=main&per_page=20`]);
  });

  it('none yet is none; a failure to ask says why', async () => {
    const none = fakeRunner({ [['glab', ...pipelinesArgs(SHA, '')].join(' ')]: '[]' });
    expect(await gitlabProvider(none.run).pipelineOn('/repo', SHA, '')).toEqual(ready({ sha: SHA, checks: 'none' }));
    expect(await gitlabProvider(fakeRunner({}).run).pipelineOn('/repo', SHA, 'main')).toMatchObject({ state: 'unavailable' });
  });
});

describe('creating a merge request through glab', () => {
  const REPO_VIEW = 'glab repo view --output json';
  const OPEN = 'glab mr list --source-branch=feat/x --output json';
  const PUSH = 'git push --set-upstream origin refs/heads/feat/x:refs/heads/feat/x';
  const CREATE = 'glab mr create --source-branch=feat/x --target-branch=main --title=Make search instant --description=Body text --yes';
  const form = { title: 'Make search instant', body: 'Body text', base: 'main', draft: false };

  it('finds the default branch with glab repo view', async () => {
    const { run, calls } = fakeRunner({ [REPO_VIEW]: JSON.stringify({ default_branch: 'trunk', path_with_namespace: 'devops/r' }), 'git config --get branch.feat/x.kestrelbase': { code: 1 } });
    expect(await preparePR('/repo', 'feat/x', false, { run, commands: gitlabCommands })).toEqual({ title: '', body: '', base: 'trunk', draft: false, inherited: 0 });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([['glab', 'repo', 'view', '--output', 'json'], ['git', 'config', '--get', 'branch.feat/x.kestrelbase']]);
    await expect(preparePR('/repo', 'feat/x', false, { run: fakeRunner({ [REPO_VIEW]: '{}' }).run, commands: gitlabCommands })).rejects.toThrow(/default branch/);
  });

  it('returns an open merge request for the branch without pushing', async () => {
    const { run, calls } = fakeRunner({ [OPEN]: JSON.stringify([mr(9)]) });
    expect(await publishPR('/repo', 'feat/x', form, { run, commands: gitlabCommands })).toEqual({ url: `${WEB}/9` });
    expect(calls).toHaveLength(1);
  });

  it('otherwise pushes the branch, then creates it with exact arguments and reads its address', async () => {
    const printed = `Creating merge request for feat/x into main in devops/r\n\n!13 Make search instant (feat/x)\n ${WEB}/13\n`;
    const { run, calls } = fakeRunner({ [OPEN]: '[]', [PUSH]: '', [CREATE]: printed });
    expect(await publishPR('/repo', 'feat/x', form, { run, commands: gitlabCommands })).toEqual({ url: `${WEB}/13` });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['glab', 'mr', 'list', '--source-branch=feat/x', '--output', 'json'],
      ['git', 'push', '--set-upstream', 'origin', 'refs/heads/feat/x:refs/heads/feat/x'],
      ['glab', 'mr', 'create', '--source-branch=feat/x', '--target-branch=main', '--title=Make search instant', '--description=Body text', '--yes'],
    ]);
  });

  it('adds --draft only when asked', async () => {
    const { run, calls } = fakeRunner({ [OPEN]: '[]', [PUSH]: '', [`${CREATE} --draft`]: `${WEB}/14` });
    expect(await publishPR('/repo', 'feat/x', { ...form, draft: true }, { run, commands: gitlabCommands })).toEqual({ url: `${WEB}/14` });
    expect(calls.at(-1)!.args.at(-1)).toBe('--draft');
  });

  it('picks the merge request address out of what glab printed', () => {
    expect(glabCreatedUrl(`see https://${HOST}/help\n${WEB}/15\n`)).toBe(`${WEB}/15`);
    expect(glabCreatedUrl(`https://${HOST}/devops/r/-/merge_requests/16/diffs`)).toBe(`${WEB}/16/diffs`);
  });
});
