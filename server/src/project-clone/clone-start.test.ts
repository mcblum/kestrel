// A worker node starts a session, asked by another device, in an account project it has never seen (item 64;
// worker-nodes.md section 9), with real git repositories in a temporary folder standing in for `origin`: git's own
// `url.<base>.insteadOf` turns the address the node clones from (`git@example.test:acme/shop.git`) into that folder,
// so the clone keeps the address a real node would, and its repository key is the account project's. No network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../agents/types.ts';
import { runGitFetch, type FetchRunner } from '../base-refresh.ts';
import { ConnectDispatcher } from '../connect/dispatcher.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { worktreeWork } from '../node-control/uninstall-node.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { offersNow, offersSource } from '../remote-starts/offers.ts';
import { SessionRuntime } from '../runtime.ts';
import type { ConnectResponse } from '../shared/connect-ops.ts';
import { keyCannotReadRefusal, noKeyRefusal, plainFolderRefusal } from '../shared/project-clone.ts';
import { doesNotHave } from '../shared/start-computer.ts';
import { FakeAgents, until } from '../test-agent.ts';
import { makeRepo } from '../test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { Workspace } from '../workspace.ts';
import { lsRemote, type CloneProbe } from './checks.ts';
import { gitClone, ProjectCloner, type CloneRun } from './clone.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));

const SHOP = 'example.test/acme/shop';
const API = 'example.test/acme/api';
const MISSING = 'example.test/acme/missing';
const origins = tempDir('origins');

/** A bare repository at `origins/<path>.git` with one commit on main; answers its tip. */
function origin(path: string): string {
  const bare = join(origins, `${path}.git`);
  mkdirSync(join(bare, '..'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = makeRepo();
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'main');
  return git(work, 'rev-parse', 'HEAD');
}

/** One more commit on `origins/<path>.git`'s main, made elsewhere; answers the new tip. */
function pushNewer(path: string): string {
  const other = join(tempDir('other'), 'clone');
  execFileSync('git', ['clone', '-q', join(origins, `${path}.git`), other], { stdio: 'ignore' });
  writeFileSync(join(other, 'newer.txt'), 'newer\n');
  git(other, 'add', '.');
  git(other, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'newer');
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

let globalConfig: string | undefined;
beforeAll(() => {
  origin('acme/shop');
  origin('acme/api');
  // The address a node clones from, turned into the folder above for every git this test runs (the clone, ls-remote, fetch).
  const config = join(tempDir('gitconfig'), 'gitconfig');
  writeFileSync(config, `[url "file://${origins}/"]\n\tinsteadOf = git@example.test:\n[protocol "file"]\n\tallow = always\n`);
  globalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
});
afterAll(() => {
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
});

type Folder = { name: string; isGit: boolean; repo?: string | null };

/** A worker node that knows the Mac mini's projects from the account, with a dispatcher that clones on demand. */
async function node(opts: { kind?: 'node' | 'app'; probe?: Partial<CloneProbe>; projects?: { id: string; name: string; repos: string[]; folders: Folder[] }[] } = {}) {
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fake.adapter(), agent: a }])) as Record<Agent, AgentAdapter>;
  const fetches: string[] = [];
  const baseFetch: FetchRunner = (repo, args, timeoutMs) => (fetches.push(repo), runGitFetch(repo, args, timeoutMs));
  const dataDir = tempDir('node');
  const runtime = new SessionRuntime(workspace, adapters, dataDir, { baseFetch });
  const projects = opts.projects ?? [{ id: 'p-mini', name: 'Shop', repos: [SHOP, API], folders: [{ name: 'shop', isGit: true, repo: SHOP }, { name: 'api', isGit: true, repo: API }] }];
  await workspace.accountProjects.apply({ projects: projects.map((p) => ({ record: `r-${p.id}`, project: { ...p, machine: { id: 'mini', name: 'Mac mini' } } })), gone: [], members: ['mini'], whole: true, mark: null });
  const clones: string[] = [];
  const run: CloneRun = (url, dest, o) => (clones.push(url), gitClone(url, dest, o));
  const root = join(dataDir, 'projects');
  const probe: CloneProbe = { keyReady: () => true, freeBytes: () => 64 * 1024 ** 3, lsRemote, ...opts.probe };
  const kind = opts.kind ?? 'node';
  const here = kind === 'node' ? 'Worker node 1' : 'your Mac';
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: 'node-1', here, send: () => undefined, keptOff: () => [], kind, clones: kind === 'node' ? { cloner: new ProjectCloner({ root, workspace, run }), probe } : null });
  const start = async (args: Record<string, unknown>): Promise<ConnectResponse> => dispatcher.answer('laptop', { op: 'session.start', args: { mode: 'auto', ...args } });
  const session = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
  const settle = async () => {
    await fake.settled();
    for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
  };
  return { workspace, runtime, fake, dataDir, root, clones, fetches, start, session, settle, here };
}

const idOf = (answer: ConnectResponse): string => {
  if (!answer.ok) throw new Error(answer.reason);
  return (answer.result as { sessionId: string }).sessionId;
};

describe.each(SELECTABLE_AGENTS)('a %s session started on a node in a project it has never seen', (agent) => {
  it('clones each repository, registers the same account project, and starts from the latest base', async () => {
    const n = await node();
    const answer = await n.start({ projectId: 'p-mini', agent, text: 'fix the build' });
    // Accepted once the row is made: it says what is being cloned, with no project yet.
    expect(answer).toMatchObject({ ok: true, result: { note: 'Cloning acme/shop and acme/api…' } });
    const id = idOf(answer);
    await until(async () => (await n.session(id)).worktreePath !== null, 'the worktree');
    await n.settle();

    const [project, ...others] = (await n.workspace.state()).projects;
    expect(others).toEqual([]);
    expect(project!.name).toBe('Shop');
    expect(project!.folders.map((f) => f.path)).toEqual([join(n.root, 'shop', 'shop'), join(n.root, 'shop', 'api')]);
    expect(await n.workspace.repos.ofProject(project!)).toEqual([SHOP, API]);
    // One project on every computer: matched with the Mac mini's by its repositories, never its name.
    const listed = (await n.workspace.view()).projects;
    expect(listed.filter((p) => p.away)).toEqual([]);
    expect(listed.find((p) => p.id === project!.id)?.alsoOn).toEqual([{ id: 'mini', name: 'Mac mini', projectId: 'p-mini' }]);

    const s = await n.session(id);
    expect(s).toMatchObject({ startedIn: project!.id, state: expect.not.stringMatching('failed') });
    expect(git(s.worktreePath!, 'rev-parse', 'HEAD')).toBe(git(join(origins, 'acme/shop.git'), 'rev-parse', 'main'));
    expect(n.fake.turns.at(-1)).toMatchObject({ text: 'fix the build', options: { permission: 'auto' } });
    expect(n.fake.starts.at(-1)!.options.directory).toBe(s.worktreePath);
    expect(n.clones).toEqual(['git@example.test:acme/shop.git', 'git@example.test:acme/api.git']);
  });
});

describe('later sessions, and what the node offers', () => {
  it('offers the project to clone before, its own project after; a second start fetches and does not clone again', async () => {
    const n = await node();
    const offered = async () => (await offersNow(offersSource(n.runtime, n.workspace, 'Worker node 1', '/home/someone', 'someone', 'node'), [])).projects;
    expect(await offered()).toEqual([{ id: 'p-mini', name: 'Shop', folders: [], defaultFolderId: null, clone: { of: ['p-mini'] } }]);

    const first = idOf(await n.start({ projectId: 'p-mini', text: 'one' }));
    await until(async () => (await n.session(first)).worktreePath !== null, 'the first worktree');
    await n.settle();
    const project = (await n.workspace.state()).projects[0]!;
    expect((await offered()).map((p) => ({ id: p.id, clone: p.clone }))).toEqual([{ id: project.id, clone: undefined }]);

    const tip = pushNewer('acme/shop');
    // Named by the Mac mini's id, as a device that read the old offers would: the node's own project of that repository.
    const second = idOf(await n.start({ projectId: 'p-mini', text: 'two' }));
    expect((await n.session(second)).note).not.toMatch(/Cloning/);
    await until(async () => (await n.session(second)).worktreePath !== null, 'the second worktree');
    await n.settle();
    expect((await n.session(second)).startedIn).toBe(project.id);
    expect(n.clones).toHaveLength(2);
    expect(n.fetches).toContain(project.folders[0]!.path);
    expect([tip, git(join(origins, 'acme/shop.git'), 'rev-parse', 'main~1')]).toContain(git((await n.session(second)).worktreePath!, 'rev-parse', 'HEAD'));

    // Uninstall's refusal covers a cloned project's worktree: a commit made there is work not pushed.
    const wt = (await n.session(second)).worktreePath!;
    writeFileSync(join(wt, 'work.txt'), 'work\n');
    git(wt, 'add', '.');
    git(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'work');
    const work = await worktreeWork((await n.workspace.state()).sessions);
    expect(work.find((w) => w.sessionId === second)).toMatchObject({ unpushed: 1 });
  });
});

describe('what is refused, and what a failed clone leaves', () => {
  it('a clone that fails part-way leaves nothing behind, and the row says why', async () => {
    // The host says the key may read both; the second repository is then not there to clone.
    const n = await node({ probe: { lsRemote: async () => ({ ok: true, heads: ['main'] }) }, projects: [{ id: 'p-mini', name: 'Shop', repos: [SHOP, MISSING], folders: [{ name: 'shop', isGit: true, repo: SHOP }, { name: 'missing', isGit: true, repo: MISSING }] }] });
    const id = idOf(await n.start({ projectId: 'p-mini', text: 'go' }));
    await until(async () => (await n.session(id)).note.startsWith('Failed'), 'the start fails');
    const s = await n.session(id);
    expect(s.startedIn).toBeNull();
    expect(s.note).toMatch(/^Failed · Could not clone `acme\/missing`: fatal: /);
    expect(n.runtime.overlay(id)?.messages.at(-1)?.text).toMatch(/^Could not clone `acme\/missing`: fatal: [^\n]*[^.]\. Nothing of it was kept\.$/);
    expect((await n.workspace.state()).projects).toEqual([]);
    expect(existsSync(n.root) ? readdirSync(n.root) : []).toEqual([]);
    expect(n.fake.starts).toEqual([]);
  });

  it('refuses before anything is made: no key, a repository the key may not read, a plain folder', async () => {
    const cases: [Parameters<typeof node>[0], string][] = [
      [{ probe: { keyReady: () => false } }, noKeyRefusal('Worker node 1')],
      [{ projects: [{ id: 'p-mini', name: 'Shop', repos: [MISSING], folders: [{ name: 'missing', isGit: true, repo: MISSING }] }] }, keyCannotReadRefusal('Worker node 1', MISSING)],
      [{ projects: [{ id: 'p-mini', name: 'Notes', repos: [], folders: [{ name: 'notes', isGit: false }] }] }, plainFolderRefusal('Notes', 'Mac mini')],
    ];
    for (const [setup, words] of cases) {
      const n = await node(setup);
      expect(await n.start({ projectId: 'p-mini', text: 'go' })).toEqual({ ok: false, reason: words });
      expect((await n.workspace.state()).sessions).toEqual([]);
      expect(n.clones).toEqual([]);
      expect(existsSync(n.root)).toBe(false);
    }
  });

  it('refuses a base branch that is only on another computer, before anything is cloned', async () => {
    const n = await node();
    expect(await n.start({ projectId: 'p-mini', text: 'go', base: 'feature/x' })).toEqual({ ok: false, reason: 'Push `feature/x` from Mac mini first.' });
    expect(n.clones).toEqual([]);
  });

  it('the app does not clone on demand: it says to clone it there first', async () => {
    const n = await node({ kind: 'app' });
    expect(await n.start({ projectId: 'p-mini', text: 'go' })).toEqual({ ok: false, reason: doesNotHave('your Mac', 'Shop') });
    expect((await n.workspace.state()).sessions).toEqual([]);
  });
});
