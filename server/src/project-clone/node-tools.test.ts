// What a session on a worker node is told of the account's projects, what its tools do with one the node has not
// cloned, and the push of its branch when a turn ends (worker-nodes.md 9.3), for every agent: all of it is in
// delegation.ts and the runtime, never one adapter. Real git, with `origin` a folder (`url.<base>.insteadOf`). No network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../agents/types.ts';
import { NODE_PUSH_LINE } from '../agents/instruction.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { NodePusher } from '../runtime/node-push.ts';
import { CLONED_ON_START, noKeyRefusal } from '../shared/project-clone.ts';
import { FakeAgents, until } from '../test-agent.ts';
import { makeRepo } from '../test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { Workspace } from '../workspace.ts';
import { lsRemote, type CloneProbe } from './checks.ts';
import { ProjectCloner } from './clone.ts';
import { ProjectMirror } from './mirror.ts';
import { NodeProjectPrefsStore } from './prefs.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
const origins = tempDir('origins');
const SHOP = 'example.test/acme/shop';
const shopOrigin = join(origins, 'acme/shop.git');

let globalConfig: string | undefined;
beforeAll(() => {
  mkdirSync(join(shopOrigin, '..'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', shopOrigin]);
  const work = makeRepo();
  git(work, 'remote', 'add', 'origin', shopOrigin);
  git(work, 'push', '-q', 'origin', 'main');
  const config = join(tempDir('gitconfig'), 'gitconfig');
  writeFileSync(config, `[url "file://${origins}/"]\n\tinsteadOf = git@example.test:\n[protocol "file"]\n\tallow = always\n`);
  globalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
});
afterAll(() => {
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
});

async function node(kind: 'node' | 'app', probe: Partial<CloneProbe> = {}) {
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fake.adapter(), agent: a }])) as Record<Agent, AgentAdapter>;
  const dataDir = tempDir('node');
  const runtime = new SessionRuntime(workspace, adapters, dataDir, { window: { kind, name: 'Worker node 1' } });
  await runtime.registerProject(makeRepo(), 'Mine');
  await workspace.accountProjects.apply({ projects: [{ record: 'r-shop', project: { id: 'p-shop', name: 'Shop', repos: [SHOP], folders: [{ name: 'shop', isGit: true, repo: SHOP }], machine: { id: 'mini', name: 'Mac mini' } } }], gone: [], members: ['mini'], whole: true, mark: { seq: 1, at: 0, scope: 's', members: ['mini'] } });
  if (kind === 'node') {
    const root = join(dataDir, 'projects');
    const prefs = new NodeProjectPrefsStore();
    await prefs.set({ projects: 'on-start' });
    const clones = { cloner: new ProjectCloner({ root, workspace }), probe: { keyReady: () => true, freeBytes: () => 64 * 1024 ** 3, lsRemote, ...probe } };
    runtime.useNodeProjects(new ProjectMirror({ workspace, clones, root, here: () => 'Worker node 1', keptOff: () => [], prefs, log: () => undefined }));
    runtime.useNodePush(new NodePusher({ kind, sessions: async () => (await workspace.state()).sessions, prefs, keptOff: () => [], notice: (id, text, level) => runtime.notice(id, text, level) }));
  }
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await fake.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  return { workspace, runtime, fake, settle, dataDir };
}

describe.each(SELECTABLE_AGENTS)('a %s session on a worker node', (agent) => {
  it('is told of the account’s projects it has not cloned, delegates into one, which is cloned first, and its branch is pushed', async () => {
    const n = await node('node');
    let listed: unknown[] = [];
    n.fake.script = async (turn) => {
      if (turn.text === 'look') listed = await turn.options.tools.listProjects();
      if (turn.text === 'go') await turn.options.tools.delegate({ tasks: [{ project: 'Shop', brief: 'Fix the checkout', title: 'Shop: checkout' }] });
      if (turn.text === 'Fix the checkout') {
        // Its own content per agent: the same file, parent, author and second would be the same commit as the last
        // agent's, which `origin` already has on that agent's branch, so there would be nothing to push.
        writeFileSync(join(turn.options.directory, 'fix.txt'), `fixed by ${agent}\n`);
        git(turn.options.directory, 'add', '.');
        git(turn.options.directory, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'fix');
      }
    };
    const caller = await n.runtime.start({ agent, projectId: null, prompt: 'look', permission: 'auto' });
    await n.settle();
    expect(listed.map((p) => (p as { name: string }).name)).toEqual(['Mine', 'Shop']);
    expect(listed[1]).toEqual({ name: 'Shop', cloned: false, repositories: [SHOP], note: CLONED_ON_START });
    const instruction = n.fake.starts[0]!.options.instruction;
    expect(instruction).toContain(`- Shop (${SHOP}): ${CLONED_ON_START}`);
    expect(instruction).toContain(NODE_PUSH_LINE);

    await n.runtime.reply(caller.id, 'go');
    await n.settle();
    const shop = (await n.workspace.state()).projects.find((p) => p.name === 'Shop')!;
    expect(shop.folders[0]!.path.startsWith(join(n.dataDir, 'projects'))).toBe(true);
    const child = (await n.workspace.state()).sessions.find((s) => s.startedIn === shop.id)!;
    expect(child.branch).toBeTruthy();
    await until(() => git(shopOrigin, 'branch', '--list', child.branch!).length > 0, 'the child’s branch on origin');
    expect(git(shopOrigin, 'rev-parse', `refs/heads/${child.branch}`)).toBe(git(child.worktreePath!, 'rev-parse', 'HEAD'));
  });
});

describe('what is refused, and a desktop', () => {
  it('a project the node cannot clone is the tool’s refusal, in 9.1’s words', async () => {
    const n = await node('node', { keyReady: () => false });
    let answer: { text: string; isError?: boolean } | null = null;
    n.fake.script = async (turn) => {
      if (turn.text === 'go') answer = await turn.options.tools.spawn({ project: 'Shop', brief: 'Chore', title: 'Shop: chore' });
    };
    await n.runtime.start({ agent: 'claude', projectId: null, prompt: 'go', permission: 'auto' });
    await n.settle();
    expect(answer).toEqual({ text: noKeyRefusal('Worker node 1'), isError: true });
    expect((await n.workspace.state()).projects.map((p) => p.name)).toEqual(['Mine']);
  });

  it('a desktop lists only its own projects, clones nothing and is told nothing of pushing', async () => {
    const n = await node('app');
    let listed: unknown[] = [];
    let answer: { text: string; isError?: boolean } | null = null;
    n.fake.script = async (turn) => {
      listed = await turn.options.tools.listProjects();
      answer = await turn.options.tools.spawn({ project: 'Shop', brief: 'Chore', title: 'Shop: chore' });
    };
    await n.runtime.start({ agent: 'claude', projectId: null, prompt: 'go', permission: 'auto' });
    await n.settle();
    expect(listed.map((p) => (p as { name: string }).name)).toEqual(['Mine']);
    expect(answer!.isError).toBe(true);
    expect(answer!.text).toMatch(/^No registered project "Shop"/);
    expect(n.fake.starts[0]!.options.instruction).not.toContain(NODE_PUSH_LINE);
  });
});
