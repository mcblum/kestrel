// The New PR form's routes: who may ask, the sample answers, and one creation at a time per
// checkout. The origin, the branch and every command are stand-ins: nothing reaches gh or git.
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { Workspace } from '../workspace.ts';
import type { TitleProvider } from '../agents/title-providers.ts';
import { createPRRoutes, type CreateDeps } from './create-api.ts';
import { samplePullRequests } from './fake.ts';
import { connectHint } from './glab.ts';
import type { CommandRunner } from './types.ts';

async function world() {
  const workspace = new Workspace(memoryPersistence());
  await workspace.addProject({ id: 'repo', name: 'Repo', path: '/nowhere/repo', isGit: true });
  await workspace.addProject({ id: 'plain', name: 'Plain', path: '/nowhere/plain', isGit: false });
  const base = { agent: 'claude' as const, landedIn: null, groupId: null, state: 'done' as const, note: '', worktreePath: null };
  await workspace.addSession({ ...base, id: 'git', title: 'Polish auth', startedIn: 'repo', branch: 'feat/auth' });
  await workspace.addSession({ ...base, id: 'folder', title: 'Notes', startedIn: 'plain', branch: null });
  return workspace;
}

const FORM = { title: 'Polish auth', body: 'Body', base: 'main', draft: false };

function routeWith(deps: Partial<CreateDeps> = {}) {
  return createPRRoutes({ samples: null, writers: [], originOf: async () => 'git@github.com:o/r.git', branchOf: async () => 'feat/auth', glabSignIn: async (host) => ({ signedIn: false, reason: connectHint(host) }), ...deps });
}

const post = (route: ReturnType<typeof createPRRoutes>, workspace: Workspace, id: string, action: string, body: Record<string, unknown>) =>
  route(['api', 'sessions', id, action], 'POST', async () => body, workspace);

describe('the New PR routes', () => {
  it('answers only its own POST paths', async () => {
    const workspace = await world();
    const route = routeWith();
    expect(await route(['api', 'sessions', 'git', 'pr-prepare'], 'GET', async () => ({}), workspace)).toBeNull();
    expect(await route(['api', 'sessions', 'git', 'pr-merge'], 'POST', async () => ({}), workspace)).toBeNull();
  });

  it('404 for a session that does not exist', async () => {
    const workspace = await world();
    expect(await post(routeWith(), workspace, 'missing', 'pr-prepare', { generated: false })).toEqual({ status: 404, body: { error: 'No such session' } });
  });

  it('refuses a session without a Git checkout, and a host glab is not signed in to', async () => {
    const workspace = await world();
    expect(await post(routeWith(), workspace, 'folder', 'pr-create', FORM)).toEqual({ status: 400, body: { error: 'This session needs an available Git checkout.' } });
    const elsewhere = routeWith({ originOf: async () => 'https://gitlab.example.com/o/r.git' });
    expect(await post(elsewhere, workspace, 'git', 'pr-create', FORM)).toEqual({ status: 400, body: { error: 'Install glab and run `glab auth login --hostname gitlab.example.com` to connect merge requests' } });
  });

  it('prepares from the checkout: the default branch, through the runner', async () => {
    const workspace = await world();
    const run: CommandRunner = async () => ({ stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }) });
    expect(await post(routeWith({ run }), workspace, 'git', 'pr-prepare', { generated: false })).toEqual({ status: 200, body: { title: '', body: '', base: 'main', draft: false, inherited: 0 } });
  });

  it('asks the session\'s own agent with the model stored in its settings', async () => {
    const workspace = await world();
    await workspace.setDetail('git', { settings: { model: 'opus', permission: 'ask' } });
    const models: (string | undefined)[] = [];
    const writer: TitleProvider = { name: 'claude', agent: 'claude', title: async () => null, pullRequestText: async (_request, model) => (models.push(model), 'Polish the auth flow\n\n- Tidier login') };
    const answers: Record<string, string> = {
      'gh repo view --json defaultBranchRef': JSON.stringify({ defaultBranchRef: { name: 'main' } }),
      'git log --format=%s origin/main..feat/auth --': 'feat: polish auth',
      'git diff --stat origin/main...feat/auth --': ' a.ts | 1 +',
      'git diff --no-color --no-ext-diff origin/main...feat/auth --': '+x',
    };
    const run: CommandRunner = async (bin, args) => {
      const answer = answers[[bin, ...args].join(' ')];
      if (answer === undefined) throw new Error('not set');
      return { stdout: answer };
    };
    const route = routeWith({ run, writers: [writer], wait: () => new Promise(() => undefined) });
    expect(await post(route, workspace, 'git', 'pr-prepare', { generated: true })).toMatchObject({ status: 200, body: { title: 'Polish the auth flow', inherited: 0 } });
    expect(models).toEqual(['opus']);
  });

  it('says what is wrong with the form as a 400, without running anything', async () => {
    const workspace = await world();
    const ran: string[] = [];
    const run: CommandRunner = async (bin) => (ran.push(bin), { stdout: '[]' });
    expect(await post(routeWith({ run }), workspace, 'git', 'pr-create', { ...FORM, title: '' })).toEqual({ status: 400, body: { error: 'Enter a title (up to 256 characters).' } });
    expect(ran).toEqual([]);
  });

  it('refuses a second creation for the same checkout while one is on its way (409)', async () => {
    const workspace = await world();
    let release = () => undefined as void;
    let reached = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const atGh = new Promise<void>((resolve) => (reached = resolve));
    const run: CommandRunner = async (_bin, args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        reached();
        await held;
      }
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/12' };
      return { stdout: args[0] === 'pr' ? '[]' : '' };
    };
    const route = routeWith({ run });
    const first = post(route, workspace, 'git', 'pr-create', FORM);
    // The first is now waiting on gh.
    await atGh;
    expect(await post(route, workspace, 'git', 'pr-create', FORM)).toEqual({ status: 409, body: { error: 'A pull request is already being created for this checkout.' } });
    release();
    expect(await first).toEqual({ status: 200, body: { url: 'https://github.com/o/r/pull/12' } });
    // Once it is done, another may go.
    expect((await post(route, workspace, 'git', 'pr-create', FORM))!.status).toBe(200);
  });

  it('on a GitLab host glab is signed in to: prepares and creates through glab, in merge-request words', async () => {
    const workspace = await world();
    const ran: string[] = [];
    let release = () => undefined as void;
    let reached = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const atGlab = new Promise<void>((resolve) => (reached = resolve));
    const run: CommandRunner = async (bin, args) => {
      ran.push([bin, ...args.slice(0, 2)].join(' '));
      if (args[0] === 'repo') return { stdout: JSON.stringify({ default_branch: 'main' }) };
      if (args[1] === 'list') {
        reached();
        await held;
        return { stdout: '[]' };
      }
      return { stdout: args[1] === 'create' ? 'https://starfish.example.io/o/r/-/merge_requests/3' : '' };
    };
    const route = routeWith({ run, originOf: async () => 'git@starfish.example.io:o/r.git', glabSignIn: async () => ({ signedIn: true }) });
    expect(await post(route, workspace, 'git', 'pr-prepare', { generated: false })).toEqual({ status: 200, body: { title: '', body: '', base: 'main', draft: false, inherited: 0 } });
    const first = post(route, workspace, 'git', 'pr-create', FORM);
    await atGlab;
    expect(await post(route, workspace, 'git', 'pr-create', FORM)).toEqual({ status: 409, body: { error: 'A merge request is already being created for this checkout.' } });
    release();
    expect(await first).toEqual({ status: 200, body: { url: 'https://starfish.example.io/o/r/-/merge_requests/3' } });
    expect(ran).toEqual(['glab repo view', 'git config --get', 'glab mr list', 'git push --set-upstream', 'glab mr create']);
  });

  it('with sample data: a pre-fill without gh or git, and a made-up pull request the lookup then finds', async () => {
    const workspace = await world();
    const samples = samplePullRequests();
    const run: CommandRunner = async () => {
      throw new Error('sample mode must not run commands');
    };
    const route = routeWith({ samples, run, originOf: async () => null, branchOf: async () => null });
    expect(await post(route, workspace, 'git', 'pr-prepare', { generated: false })).toEqual({ status: 200, body: { title: '', body: '', base: 'main', draft: false, inherited: 0 } });
    const generated = await post(route, workspace, 'git', 'pr-prepare', { generated: true });
    expect(generated).toMatchObject({ status: 200, body: { title: 'Polish auth', base: 'main', draft: false } });
    expect((generated!.body as { body: string }).body).toContain('## Testing\n\nNot recorded.');
    const created = await post(route, workspace, 'git', 'pr-create', FORM);
    expect(created).toEqual({ status: 200, body: { url: 'https://github.com/example/sample/pull/501' } });
    const found = await samples.pullRequestsFor('', 'feat/auth');
    expect(found.state === 'ready' && found.value.map((p) => [p.number, p.state, p.title])).toEqual([[501, 'open', 'Polish auth']]);
    expect(await post(route, workspace, 'folder', 'pr-prepare', { generated: false })).toEqual({ status: 400, body: { error: 'This session has no branch.' } });
  });
});
