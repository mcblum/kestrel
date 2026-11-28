// A worker node mirrors the account's projects (worker-nodes.md 9.3), with real git repositories in a temporary folder
// standing in for `origin`, as clone-start.test.ts does: git's `url.<base>.insteadOf` turns the address the node clones
// from (`git@example.test:acme/shop.git`) into that folder. No network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountHead } from '../shared/machines.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { Refused } from '../refused.ts';
import { CLONED_ON_START, keyCannotReadRefusal, lowDiskRefusal, plainFolderRefusal } from '../shared/project-clone.ts';
import { MIRROR_FETCH_MIN_MS } from '../shared/project-mirror.ts';
import { makeRepo } from '../test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { Workspace } from '../workspace.ts';
import { lsRemote, type CloneProbe } from './checks.ts';
import { gitClone, ProjectCloner, type CloneRun } from './clone.ts';
import { ProjectMirror } from './mirror.ts';
import { NodeProjectPrefsStore } from './prefs.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));

const origins = tempDir('origins');
const key = (name: string) => `example.test/acme/${name}`;

function origin(path: string): void {
  const bare = join(origins, `${path}.git`);
  mkdirSync(join(bare, '..'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = makeRepo();
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'main');
}

let globalConfig: string | undefined;
beforeAll(() => {
  for (const name of ['alpha', 'bravo', 'charlie', 'delta']) origin(`acme/${name}`);
  const config = join(tempDir('gitconfig'), 'gitconfig');
  writeFileSync(config, `[url "file://${origins}/"]\n\tinsteadOf = git@example.test:\n[protocol "file"]\n\tallow = always\n`);
  globalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
});
afterAll(() => {
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
});

type Rec = { id: string; name: string; repos: string[]; folders: { name: string; isGit: boolean; repo?: string | null }[] };
const repoProject = (name: string): Rec => ({ id: `p-${name}`, name: name[0]!.toUpperCase() + name.slice(1), repos: [key(name)], folders: [{ name, isGit: true, repo: key(name) }] });
const MARK = { seq: 1, at: 0, scope: 's', members: ['mini'] };

async function node(opts: { projects?: Rec[]; probe?: Partial<CloneProbe>; mode?: 'every' | 'on-start' } = {}) {
  const workspace = new Workspace(memoryPersistence());
  const dataDir = tempDir('node');
  const root = join(dataDir, 'projects');
  let active = 0;
  let most = 0;
  const clones: string[] = [];
  const run: CloneRun = async (url, dest, o) => {
    clones.push(url);
    active++;
    most = Math.max(most, active);
    try {
      await gitClone(url, dest, o);
    } finally {
      active--;
    }
  };
  const probe: CloneProbe = { keyReady: () => true, freeBytes: () => 64 * 1024 ** 3, lsRemote, ...opts.probe };
  const prefs = new NodeProjectPrefsStore();
  if (opts.mode) await prefs.set({ projects: opts.mode });
  const fetches: string[] = [];
  let now = 1_000_000;
  const logs: string[] = [];
  const mirror = new ProjectMirror({ workspace, clones: { cloner: new ProjectCloner({ root, workspace, run }), probe }, root, here: () => 'Worker node 1', keptOff: () => [], prefs, fetch: async (folder) => void fetches.push(folder), now: () => now, log: (t) => logs.push(t) });
  const account = (projects: Rec[], whole = true) => workspace.accountProjects.apply({ projects: projects.map((p) => ({ record: `r-${p.id}`, project: { ...p, machine: { id: 'mini', name: 'Mac mini' } } })), gone: [], members: ['mini'], whole, mark: MARK });
  await account(opts.projects ?? [repoProject('alpha'), repoProject('bravo')]);
  const names = async () => (await workspace.state()).projects.map((p) => p.name).sort();
  return { workspace, mirror, root, clones, prefs, fetches, logs, account, names, most: () => most, tick: (ms: number) => (now += ms) };
}

describe('a node mirrors every project of the account it can clone', () => {
  it('clones each, two at a time, and its agents are then told of none it lacks', async () => {
    const n = await node({ projects: ['alpha', 'bravo', 'charlie', 'delta'].map(repoProject) });
    await n.mirror.reconcile();
    expect(await n.names()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(n.most()).toBeLessThanOrEqual(2);
    expect(n.clones).toHaveLength(4);
    expect(await n.mirror.rows()).toEqual([]);
    expect(await n.mirror.status()).toMatchObject({ here: 4, notHere: 0, cloning: 0, notCloned: [] });
    // Derived again, not remembered: a second pass clones nothing more.
    await n.mirror.reconcile();
    expect(n.clones).toHaveLength(4);
  });

  it('never a plain folder; its row and the status say why in 9.1’s words', async () => {
    const notes: Rec = { id: 'p-notes', name: 'Notes', repos: [], folders: [{ name: 'notes', isGit: false }] };
    const n = await node({ projects: [repoProject('alpha'), notes] });
    await n.mirror.reconcile();
    expect(await n.names()).toEqual(['Alpha']);
    expect(await n.mirror.rows()).toEqual([{ name: 'Notes', cloned: false, repositories: [], note: plainFolderRefusal('Notes', 'Mac mini') }]);
    expect((await n.mirror.status()).notCloned).toEqual([{ name: 'Notes', why: plainFolderRefusal('Notes', 'Mac mini') }]);
  });

  it('keeps why the key could not read one, and tries it again at the next trigger', async () => {
    let denied = true;
    const n = await node({ projects: [repoProject('alpha')], probe: { lsRemote: async (url, ms) => (denied ? { ok: false, why: 'denied' } : lsRemote(url, ms)) } });
    await n.mirror.reconcile();
    expect(await n.names()).toEqual([]);
    expect(await n.mirror.rows()).toEqual([{ name: 'Alpha', cloned: false, repositories: [key('alpha')], note: keyCannotReadRefusal('Worker node 1', key('alpha')) }]);
    denied = false;
    await n.mirror.reconcile(); // as the socket's `git` does
    expect(await n.names()).toEqual(['Alpha']);
  });

  it('stops the pass for lack of disk, and says how much is free', async () => {
    const n = await node({ probe: { freeBytes: () => 512 * 1024 ** 2 } });
    await n.mirror.reconcile();
    expect(n.clones).toEqual([]);
    expect((await n.mirror.status()).lowDisk).toBe(lowDiskRefusal('Worker node 1', 512 * 1024 ** 2));
  });

  it('with "Clone a project when a session starts in it", clones nothing by itself and says when it will', async () => {
    const n = await node({ mode: 'on-start' });
    await n.mirror.reconcile();
    expect(n.clones).toEqual([]);
    expect((await n.mirror.rows()).map((r) => r.note)).toEqual([CLONED_ON_START, CLONED_ON_START]);
    expect(await n.mirror.status()).toMatchObject({ here: 0, notHere: 2, mode: 'on-start' });
  });

  it('clones a project added on another computer when the projects feed is read, with nobody asking', async () => {
    const n = await node({ projects: [repoProject('alpha')] });
    n.mirror.start();
    await n.mirror.reconcile();
    expect(await n.names()).toEqual(['Alpha']);
    await n.account([repoProject('alpha'), repoProject('bravo')], false);
    await n.mirror.reconcile(); // waits for the pass the reading started
    expect(await n.names()).toEqual(['Alpha', 'Bravo']);
    n.mirror.stop();
  });
});

describe('a tool names a project the node has not cloned', () => {
  it('is cloned once, through the same cloner, and is then this computer’s project', async () => {
    const n = await node({ mode: 'on-start' });
    const project = await n.mirror.cloneNamed('bravo');
    expect(project?.name).toBe('Bravo');
    expect(await n.mirror.cloneNamed(key('alpha'))).toMatchObject({ name: 'Alpha' });
    expect(await n.mirror.cloneNamed('Nothing of that name')).toBeNull();
    expect(n.clones).toHaveLength(2);
  });

  it('is refused in 9.1’s words when it cannot be cloned', async () => {
    const n = await node({ mode: 'on-start', probe: { keyReady: () => false } });
    await expect(n.mirror.cloneNamed('Alpha')).rejects.toThrow(Refused);
    await expect(n.mirror.cloneNamed('Alpha')).rejects.toThrow('Worker node 1 has no git key of its own yet.');
  });
});

describe('fresh clones', () => {
  const head = (id: string, repos: string[]): AccountHead =>
    ({ id, title: 'work', agent: 'claude', state: 'running', note: '', runsOn: 'mini', project: { id: 'p-alpha', name: 'Alpha' }, repos, createdAt: 0, updatedAt: 0, filing: 'started' }) as unknown as AccountHead;

  it('fetches a mirrored clone when another computer’s session in it changes, at most once per interval', async () => {
    const n = await node({ projects: [repoProject('alpha')] });
    await n.mirror.reconcile();
    n.mirror.start();
    const folder = (await n.workspace.state()).projects[0]!.folders[0]!.path;
    const machine = { id: 'mini', name: 'Mac mini' };
    const apply = (h: AccountHead) => n.workspace.account.apply({ heads: [{ machine, head: h }], gone: [], members: ['mini'], whole: false, mark: null });
    await apply(head('s1', [key('alpha')]));
    await vi.waitFor(() => expect(n.fetches).toEqual([folder]));
    await apply({ ...head('s1', [key('alpha')]), title: 'more work' } as AccountHead);
    await new Promise((r) => setTimeout(r, 20));
    expect(n.fetches).toHaveLength(1);
    n.tick(MIRROR_FETCH_MIN_MS);
    await apply({ ...head('s1', [key('alpha')]), title: 'even more' } as AccountHead);
    await vi.waitFor(() => expect(n.fetches).toHaveLength(2));
    n.mirror.stop();
  });
});

describe('a clone the account no longer has', () => {
  it('is deleted when no session is in it; the log names no project', async () => {
    const n = await node({ projects: [repoProject('alpha'), repoProject('bravo')] });
    await n.mirror.reconcile();
    const bravo = (await n.workspace.state()).projects.find((p) => p.name === 'Bravo')!;
    await n.account([repoProject('alpha')]);
    await n.mirror.reconcile();
    expect(await n.names()).toEqual(['Alpha']);
    expect(existsSync(bravo.folders[0]!.path)).toBe(false);
    expect(n.logs.join('\n')).not.toMatch(/Bravo|bravo/);
  });

  it('stays while a session is in it, and the status names it', async () => {
    const n = await node({ projects: [repoProject('alpha')] });
    await n.mirror.reconcile();
    const alpha = (await n.workspace.state()).projects[0]!;
    await n.workspace.addSession({ title: 'Fix it', agent: 'claude', startedIn: alpha.id, state: 'done' });
    await n.account([]);
    await n.mirror.reconcile();
    expect(await n.names()).toEqual(['Alpha']);
    expect((await n.mirror.status()).kept).toEqual([{ name: 'Alpha', why: '1 session is still listed in it' }]);
  });

  it('deletes nothing before the account was ever read', async () => {
    const n = await node({ projects: [repoProject('alpha')] });
    await n.mirror.reconcile();
    await n.workspace.accountProjects.clear();
    await n.mirror.reconcile();
    expect(await n.names()).toEqual(['Alpha']);
  });
});
