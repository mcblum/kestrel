import { describe, expect, it, vi } from 'vitest';
import { inspectMerge, performMerge, type MergeContext } from './merge.ts';
import type { CommandRunner } from './types.ts';
const sha = 'a'.repeat(40);
const ctx: MergeContext = { cwd: '/repo', host: 'github', repository: 'owner/repo', hostname: 'github.com', branch: 'feature' };
const pr = { number: 181, state: 'OPEN', headRefName: 'feature', baseRefName: 'main', headRefOid: sha, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', url: 'https://github.com/owner/repo/pull/181' };
const repo = { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false };
function runner(...responses: unknown[]) {
  return vi.fn<CommandRunner>().mockImplementation(async () => ({ stdout: JSON.stringify(responses.shift()) }));
}
const expected = { sha, base: 'main', method: 'squash' };
describe('merge confirmation', () => {
  it('offers only repository-enabled methods and a fresh commit', async () => {
    const run = runner(pr, repo);
    const offer = await inspectMerge(ctx, 181, run);
    expect(offer.methods.map(m => m.id)).toEqual(['squash']);
    expect(offer.pr.headSha).toBe(sha);
    expect(offer.pr.checksUrl).toBe(`${pr.url}/checks`);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('merges with the confirmed SHA and method after a fresh inspection', async () => {
    const run = runner(pr, repo, { merged: true });
    await expect(performMerge(ctx, 181, expected, run)).resolves.toEqual({ merged: true });
    expect(run.mock.calls[2]?.[1]).toEqual(['api', '--method', 'PUT', 'repos/owner/repo/pulls/181/merge', '-f', `sha=${sha}`, '-f', 'merge_method=squash']);
  });
  it.each([
    ['changed head', { ...pr, headRefOid: 'b'.repeat(40) }],
    ['changed target', { ...pr, baseRefName: 'release' }],
    ['different branch', { ...pr, headRefName: 'other' }],
    ['draft', { ...pr, isDraft: true }],
    ['blocked', { ...pr, mergeStateStatus: 'BLOCKED' }],
    ['failed checks', { ...pr, statusCheckRollup: [{ conclusion: 'FAILURE' }] }],
    ['missing SHA', { ...pr, headRefOid: undefined }],
    ['merged', { ...pr, state: 'MERGED' }],
  ])('refuses %s without sending a merge', async (_, changed) => {
    const run = runner(changed, repo);
    await expect(performMerge(ctx, 181, expected, run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('refuses a method that is no longer allowed', async () => {
    const run = runner(pr, { allow_merge_commit: true });
    await expect(performMerge(ctx, 181, expected, run)).rejects.toThrow('no longer allowed');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not report a rejected merge as success', async () => {
    await expect(performMerge(ctx, 181, expected, runner(pr, repo, { merged: false, message: 'Blocked' }))).rejects.toThrow('Blocked');
  });
  it('uses the configured GitLab host, project rules and atomic SHA guard', async () => {
    const run = runner({ iid: 181, state: 'opened', source_branch: 'feature', target_branch: 'main', sha, detailed_merge_status: 'mergeable', head_pipeline: { status: 'success', web_url: 'https://git.example/team/repo/-/pipelines/42' } }, { squash_option: 'always', merge_method: 'ff' }, { state: 'merged' });
    await performMerge({ ...ctx, host: 'gitlab', hostname: 'git.example' }, 181, expected, run);
    expect(run.mock.calls[2]?.[0]).toBe('glab');
    expect(run.mock.calls[2]?.[1]).toEqual(['api', '--hostname', 'git.example', '--method', 'PUT', 'projects/owner%2Frepo/merge_requests/181/merge', '-f', `sha=${sha}`, '-F', 'squash=true']);
  });
});
