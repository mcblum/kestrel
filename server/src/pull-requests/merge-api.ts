import type { Workspace } from '../workspace.ts';
import { folderOf } from '../shared/project-folders.ts';
import { currentBranch, originUrl } from '../git.ts';
import { repositoryWebUrl } from '../repository-url.ts';
import { resolveProvider } from './choose.ts';
import { sharedGlabSignIn } from './glab.ts';
import { ghFailureReason } from './github.ts';
import { inspectMerge, performMerge, type MergeContext } from './merge.ts';
import type { PullRequestStore } from './store.ts';
const active = new Set<string>();
export async function mergePRRoute(parts: readonly string[], method: string, read: () => Promise<Record<string, unknown>>, workspace: Workspace, sample: boolean, store: PullRequestStore) {
  if (method !== 'POST' || parts.length !== 4 || parts[1] !== 'sessions' || !['pr-merge-preview', 'pr-merge'].includes(parts[3]!)) return null;
  if (sample) return { status: 400, body: { error: 'Merging is unavailable for sample sessions.' } };
  try {
    const state = await workspace.state();
    const session = state.sessions.find(s => s.id === parts[2]);
    if (!session) return {status:404,body:{error:'No such session'}};
    const project = state.projects.find(p => p.id === session.startedIn);
    const folder = project && folderOf(project, session.folderId);
    if (!folder?.isGit || session.worktreeDiscarded) throw new Error('The session needs an available Git checkout.');
    const cwd = session.worktreePath ?? folder.path;
    const origin = await originUrl(cwd);
    const choice = await resolveProvider(origin, sharedGlabSignIn);
    if (choice.kind === 'none') throw new Error(choice.reason);
    const web = repositoryWebUrl(origin);
    if (!web) throw new Error('The origin remote has no repository URL.');
    const url = new URL(web);
    const branch = await currentBranch(cwd);
    if (!branch) throw new Error('The session has no branch.');
    const ctx: MergeContext = {cwd, branch, host:choice.kind, hostname:url.hostname, repository:decodeURIComponent(url.pathname.slice(1))};
    const body = await read();
    if (!Number.isSafeInteger(body.number) || Number(body.number) < 1) throw new Error('Invalid request number.');
    const number = Number(body.number);
    if (parts[3] === 'pr-merge-preview') return {status:200,body:await inspectMerge(ctx, number)};
    if (typeof body.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(body.sha) || typeof body.base !== 'string' || typeof body.method !== 'string') throw new Error('Invalid merge confirmation.');
    const key = `${web}:${number}`;
    if (active.has(key)) throw new Error('A merge is already in progress.');
    active.add(key);
    try { return {status:200,body:await performMerge(ctx, number, {sha:body.sha,base:body.base,method:body.method})}; }
    finally { active.delete(key); store.due(session.id); }
  } catch (error) { return {status:400,body:{error:ghFailureReason(error)}}; }
}
