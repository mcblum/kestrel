import { execRunner, GH_FIELDS, mapGhItem } from './github.ts';
import { mapGlabMergeRequest } from './gitlab.ts';
import { pullRequestStatus, type PullRequest } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import type { CommandRunner } from './types.ts';

export interface MergeContext { cwd: string; host: HostKind; repository: string; hostname: string; branch: string }
export interface MergeOffer { pr: PullRequest; methods: { id: string; label: string }[] }
export function assertMergeReady(pr: PullRequest, branch: string) {
  if (pr.headBranch !== branch) throw new Error('This request no longer belongs to the session’s branch.');
  if (pullRequestStatus(pr).tone !== 'green') throw new Error(`This request is not ready to merge: ${pullRequestStatus(pr).label}.`);
  if (!pr.headSha || !/^[a-f0-9]{40,64}$/i.test(pr.headSha) || !pr.baseBranch) throw new Error('The host did not provide the commit and target branch. Refresh and try again.');
}
function commands(ctx: MergeContext, run: CommandRunner) {
  return async (args: string[]) => JSON.parse((await run(ctx.host === 'github' ? 'gh' : 'glab', args, { cwd: ctx.cwd, timeoutMs: 30000 })).stdout);
}
export async function inspectMerge(ctx: MergeContext, number: number, run: CommandRunner = execRunner): Promise<MergeOffer> {
  const command = commands(ctx, run);
  let pr: PullRequest;
  let methods: MergeOffer['methods'];
  if (ctx.host === 'github') {
    pr = mapGhItem(await command(['pr', 'view', String(number), '--repo', ctx.repository, '--json', GH_FIELDS]));
    const repo = await command(['api', `repos/${ctx.repository}`]);
    methods = [
      ...(repo.allow_squash_merge === true ? [{id:'squash',label:'Squash and merge'}] : []),
      ...(repo.allow_merge_commit === true ? [{id:'merge',label:'Create a merge commit'}] : []),
      ...(repo.allow_rebase_merge === true ? [{id:'rebase',label:'Rebase and merge'}] : []),
    ];
  } else {
    const endpoint = `projects/${encodeURIComponent(ctx.repository)}`;
    pr = mapGlabMergeRequest(await command(['api', '--hostname', ctx.hostname, `${endpoint}/merge_requests/${number}?with_merge_status_recheck=true`]));
    const repo = await command(['api', '--hostname', ctx.hostname, endpoint]);
    if (!['always', 'never', 'default_on', 'default_off'].includes(repo.squash_option)) throw new Error('The host did not report its squash policy. Open the request on GitLab to merge.');
    methods = [
      ...(repo.squash_option !== 'always' ? [{id:'merge',label:`Merge using project settings (${repo.merge_method ?? 'default'})`}] : []),
      ...(repo.squash_option !== 'never' ? [{id:'squash',label:'Squash and merge'}] : []),
    ];
  }
  if (pr.number !== number) throw new Error('The host returned a different request.');
  assertMergeReady(pr, ctx.branch);
  if (!methods.length) throw new Error('No merge method is available for this repository.');
  return { pr, methods };
}
export async function performMerge(ctx: MergeContext, number: number, expected: { sha: string; base: string; method: string }, run: CommandRunner = execRunner) {
  const offer = await inspectMerge(ctx, number, run);
  if (offer.pr.headSha !== expected.sha || offer.pr.baseBranch !== expected.base) throw new Error('The commit or target branch changed. Close this confirmation and review the latest version.');
  if (!offer.methods.some(m => m.id === expected.method)) throw new Error('That merge method is no longer allowed.');
  const command = commands(ctx, run);
  if (ctx.host === 'github') {
    const result = await command(['api', '--method', 'PUT', `repos/${ctx.repository}/pulls/${number}/merge`, '-f', `sha=${expected.sha}`, '-f', `merge_method=${expected.method}`]);
    if (result.merged !== true) throw new Error(result.message || 'The host did not confirm the merge. Refresh before trying again.');
  } else {
    const result = await command(['api', '--hostname', ctx.hostname, '--method', 'PUT', `projects/${encodeURIComponent(ctx.repository)}/merge_requests/${number}/merge`, '-f', `sha=${expected.sha}`, '-F', `squash=${expected.method === 'squash'}`]);
    if (result.state !== 'merged') throw new Error('The host did not confirm the merge. Refresh before trying again.');
  }
  return { merged: true };
}
