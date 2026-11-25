import type { Workspace } from '../workspace.ts';
import { checkoutIn } from '../working-tree.ts';
import { worktreeOwnerId } from '../shared/working-tree.ts';
import { folderOf } from '../shared/project-folders.ts';
import { currentBranch, originUrl } from '../git.ts';
import { repositoryWebUrl } from '../repository-url.ts';
import { resolveProvider } from './choose.ts';
import { sharedGlabSignIn } from './glab.ts';
import { ghFailureReason } from './github.ts';
import { inspectMerge, performMerge, type MergeContext } from './merge.ts';
import type { PullRequestStore } from './store.ts';
const active = new Set<string>();

/** Where a session's request is merged from, and how the host is reached; null for no such session. Throws a reason. */
export async function mergeContextOf(workspace: Workspace, sessionId: string) {
  const state = await workspace.state();
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return null;
  const project = state.projects.find(p => p.id === session.startedIn);
  const folder = project && folderOf(project, session.folderId);
  // A guest merges from its host's worktree (working-tree.ts `checkoutIn`).
  const checkout = checkoutIn(state, session, folder);
  if ('reason' in checkout) throw new Error(checkout.reason);
  const cwd = checkout.path;
  const origin = await originUrl(cwd);
  const choice = await resolveProvider(origin, sharedGlabSignIn);
  if (choice.kind === 'none') throw new Error(choice.reason);
  const web = repositoryWebUrl(origin);
  if (!web) throw new Error('The origin remote has no repository URL.');
  const url = new URL(web);
  const branch = await currentBranch(cwd);
  if (!branch) throw new Error('The session has no branch.');
  const ctx: MergeContext = {cwd, branch, host:choice.kind, hostname:url.hostname, repository:decodeURIComponent(url.pathname.slice(1))};
  return { session, ctx, web };
}

/**
 * Autopilot's Merge when green: what the Merge dialog does, with the first method the host allows, at the
 * commit the host says is ready. One merge of a request at a time, shared with the dialog's. Throws a reason.
 */
export async function mergeWhenGreen(workspace: Workspace, store: PullRequestStore, sessionId: string, number: number): Promise<void> {
  const found = await mergeContextOf(workspace, sessionId);
  if (!found) throw new Error('The session is gone.');
  const { session, ctx, web } = found;
  const key = `${web}:${number}`;
  if (active.has(key)) throw new Error('A merge is already in progress.');
  active.add(key);
  try {
    const offer = await inspectMerge(ctx, number);
    const method = offer.methods[0];
    if (!method || !offer.pr.headSha || !offer.pr.baseBranch) throw new Error('No merge method is available for this repository.');
    await performMerge(ctx, number, { sha: offer.pr.headSha, base: offer.pr.baseBranch, method: method.id });
  } catch (error) {
    throw new Error(ghFailureReason(error));
  } finally {
    active.delete(key);
    store.due(worktreeOwnerId(session));
  }
}
export async function mergePRRoute(parts: readonly string[], method: string, read: () => Promise<Record<string, unknown>>, workspace: Workspace, sample: boolean, store: PullRequestStore) {
  if (method !== 'POST' || parts.length !== 4 || parts[1] !== 'sessions' || !['pr-merge-preview', 'pr-merge'].includes(parts[3]!)) return null;
  if (sample) return { status: 400, body: { error: 'Merging is unavailable for sample sessions.' } };
  try {
    const found = await mergeContextOf(workspace, parts[2]!);
    if (!found) return {status:404,body:{error:'No such session'}};
    const { session, ctx, web } = found;
    const body = await read();
    if (!Number.isSafeInteger(body.number) || Number(body.number) < 1) throw new Error('Invalid request number.');
    const number = Number(body.number);
    if (parts[3] === 'pr-merge-preview') return {status:200,body:await inspectMerge(ctx, number)};
    if (typeof body.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(body.sha) || typeof body.base !== 'string' || typeof body.method !== 'string') throw new Error('Invalid merge confirmation.');
    const key = `${web}:${number}`;
    if (active.has(key)) throw new Error('A merge is already in progress.');
    active.add(key);
    try { return {status:200,body:await performMerge(ctx, number, {sha:body.sha,base:body.base,method:body.method})}; }
    finally { active.delete(key); store.due(worktreeOwnerId(session)); }
  } catch (error) { return {status:400,body:{error:ghFailureReason(error)}}; }
}
