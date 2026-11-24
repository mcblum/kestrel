// A guest (shared/worktree-guests.ts) as it really is: a session row with no worktree or branch of
// its own, started by `delegate` with a role, working in its host's worktree. Everything that asks
// where a session works must get that worktree (shared/working-tree.ts): the folder its panes open
// in, its git status and counts, its Changes, and its pull requests; and a change made there must
// reach the host's list too. Matt saw each of these go wrong on 2026-11-24.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detailsRoute, type DetailsSources } from './details-api.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { PullRequestStore } from './pull-requests/store.ts';
import { SessionRuntime } from './runtime.ts';
import { ready } from './shared/sourced.ts';
import type { WhoDoesWhat } from './shared/who-does-what.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const who: WhoDoesWhat = {
  presets: [{ id: 'astra', name: 'Astra', agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false }],
  roles: { design: 'astra', build: null, review: null },
  instruction: '',
};

/** A host session with a real worktree, and a Design guest in it that wrote `TextInput.css` there and finished. */
async function hostAndGuest() {
  const workspace = new Workspace(memoryPersistence());
  const claude = new FakeAgents();
  const codex = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: claude.adapter(), codex: codex.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-guest-wt-'))));
  const project = await runtime.registerProject(makeRepo(), 'app');
  await runtime.whoDoesWhat.set(who);
  codex.script = async (turn) => {
    writeFileSync(join(turn.options.directory, 'TextInput.css'), 'input { border: 0 }\n');
    turn.emit({ type: 'message', id: 'm1', text: 'Built the TextInput styles.', delta: '', done: true });
  };
  let delegated = false;
  claude.script = async (turn) => {
    if (turn.text === 'Fix the inputs') delegated = Boolean(await turn.options.tools.delegate({ tasks: [{ project: 'app', brief: 'Restyle the text inputs', role: 'design' }] }));
  };
  const started = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix the inputs', permission: 'auto' });
  await until(() => delegated && codex.turns.length === 1, 'the design guest');
  const sessions = async () => (await workspace.state()).sessions;
  const guestId = (await sessions()).find((s) => s.agent === 'codex')!.id;
  await runtime.idle(guestId);
  await runtime.idle(started.id);
  const host = (await sessions()).find((s) => s.id === started.id)!;
  const guest = (await sessions()).find((s) => s.id === guestId)!;
  const asked: string[] = [];
  const sources: DetailsSources = {
    pullRequests: {
      pullRequestsFor: async (_repo, branch) => (asked.push(branch), ready({ host: 'github' as const, pullRequests: [{ number: 7, title: 'Inputs', url: 'https://example.com/pr/7', state: 'open', draft: false, checks: null, review: null } as never] })),
      linkedRequests: async () => ready({ host: 'github' as const, pullRequests: [] }),
    },
    store: new PullRequestStore(() => 0),
  };
  const get = async (id: string, section: string) => (await detailsRoute(['api', 'sessions', id, section], 'GET', new URL(`http://x/api/sessions/${id}/${section}`), workspace, runtime, sources, false))!.body;
  const files = (id: string) => (runtime.overlay(id)?.files ?? []).map((f) => f.path);
  return { workspace, runtime, project, host, guest, get, asked, files, sessions, claude, codex };
}

describe('a guest works in its host’s worktree, and everything says so', () => {
  it('is a session with no worktree of its own, marked with its host', async () => {
    const { host, guest } = await hostAndGuest();
    expect(host.worktreePath).not.toBeNull();
    expect(guest.worktreePath).toBeNull();
    expect(guest.branch).toBeNull();
    expect(guest.hostId).toBe(host.id);
  });

  it('opens its panes (terminal, Files, commands) in the host’s worktree, not the main checkout', async () => {
    const { runtime, host, guest } = await hostAndGuest();
    expect(await runtime.directoryOf(guest.id)).toBe(host.worktreePath);
    expect(await runtime.folderOf(guest.id)).toBe(host.worktreePath);
    expect(await runtime.folderNote(guest.id)).toBeNull();
  });

  it('reports the git status and change counts of the worktree it works in', async () => {
    const { host, guest, get } = await hostAndGuest();
    expect(await get(guest.id, 'git')).toMatchObject({ state: 'ready', value: { uncommitted: 1 } });
    expect(await get(guest.id, 'change-counts')).toMatchObject({ state: 'ready', value: { changed: 1, uncommitted: 1 } });
    expect(await get(host.id, 'change-counts')).toMatchObject({ state: 'ready', value: { changed: 1, uncommitted: 1 } });
  });

  it('lists the change it made in its own Changes and in its host’s', async () => {
    const { host, guest, files } = await hostAndGuest();
    await until(() => files(host.id).includes('TextInput.css'), 'the host’s list');
    await until(() => files(guest.id).includes('TextInput.css'), 'the guest’s list');
  });

  it('hears about a change its host makes after it finished', async () => {
    const { runtime, host, guest, files, claude } = await hostAndGuest();
    await until(() => files(guest.id).includes('TextInput.css'), 'the guest’s list');
    claude.script = async (turn) => writeFileSync(join(turn.options.directory, 'App.tsx'), 'export {}\n');
    await runtime.reply(host.id, 'Wire it in');
    await runtime.idle(host.id);
    await until(() => files(guest.id).includes('App.tsx'), 'the guest’s list after the host’s edit');
  });

  it('shows the pull request of the worktree it works in: the host’s, looked up once, under the host', async () => {
    const { host, guest, get, asked } = await hostAndGuest();
    expect(await get(guest.id, 'pull-requests')).toMatchObject({ state: 'ready', value: { pullRequests: [{ number: 7 }] } });
    expect(await get(host.id, 'pull-requests')).toMatchObject({ state: 'ready', value: { pullRequests: [{ number: 7 }] } });
    expect(asked).toEqual([host.branch]);
  });

  it('follows a branch the guest made inside the host’s worktree', async () => {
    const { host, guest, get, sessions } = await hostAndGuest();
    execFileSync('git', ['checkout', '-q', '-b', 'feature/inputs'], { cwd: host.worktreePath! });
    expect(await get(guest.id, 'git')).toMatchObject({ state: 'ready', value: { uncommitted: 1 } });
    expect((await sessions()).find((s) => s.id === host.id)!.branch).toBe('feature/inputs');
  });

  it('says why when its host’s worktree was discarded, and opens in the main checkout saying so', async () => {
    const { runtime, project, host, guest, get } = await hostAndGuest();
    await runtime.discardWorktree(host.id, false);
    expect(await get(guest.id, 'git')).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('was discarded') });
    expect(await runtime.directoryOf(guest.id)).toBe(project.folders[0]!.path);
    expect(await runtime.folderNote(guest.id)).toMatch(/was discarded, so this is the project's main checkout/);
  });
});

describe('a session whose own worktree was discarded', () => {
  it('opens its panes in the main checkout and says so', async () => {
    const { runtime, project, host } = await hostAndGuest();
    expect(await runtime.folderNote(host.id)).toBeNull();
    await runtime.discardWorktree(host.id, false);
    expect(await runtime.directoryOf(host.id)).toBe(project.folders[0]!.path);
    expect(await runtime.folderNote(host.id)).toBe(`The worktree was discarded, so this is the project's main checkout, ${project.folders[0]!.path}.`);
  });
});
