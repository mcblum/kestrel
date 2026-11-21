// The add_project tool: an agent that found code in a folder Kestrel does not know asks to add it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import type { InputRequest, KestrelToolHost, ToolResult } from './agents/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-add-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  const card = (id: string): InputRequest | undefined => runtime.overlay(id)?.messages.find((m) => m.input && !m.input.resolved)?.input as InputRequest | undefined;
  const projects = async () => (await workspace.state()).projects;

  /** Start a no-project session whose first turn makes one tool call; resolves with its result. */
  async function call(use: (tools: KestrelToolHost) => Promise<ToolResult>) {
    let result: ToolResult | undefined;
    agents.script = async (turn) => {
      if (turn.text === 'go') result = await use(turn.options.tools);
    };
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    const finished = async () => {
      await until(() => result !== undefined, 'tool result');
      await agents.settled();
      return result!;
    };
    return { id: session.id, finished };
  }

  /** The card the call raised, after answering it. */
  async function answered(id: string, optionId: 'allow' | 'deny') {
    await until(() => card(id) !== undefined, 'approval card');
    const shown = card(id)!;
    await runtime.answer(id, shown.id, { optionId });
    return shown;
  }

  const errorNotice = (id: string) => runtime.overlay(id)!.messages.find((m) => m.notice === 'error')?.text;
  return { workspace, data, runtime, a, card, projects, call, answered, errorNotice };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

describe('add_project', () => {
  it('adds a git repository after the user approves', async () => {
    const w = await world();
    const repo = makeRepo();
    const { id, finished } = await w.call((t) => t.addProject({ path: repo }));
    const shown = await w.answered(id, 'allow');
    expect(shown).toMatchObject({ kind: 'approval', tool: 'add_project', title: `Add ${basename(repo)} as a project?`, detail: `${repo}\nGit repository` });
    expect(shown.options.map((o) => [o.label, o.role])).toEqual([['Add project', 'allow'], ['Not now', 'deny']]);
    const result = await finished();
    expect(result).toEqual({ text: `Added ${basename(repo)} (${repo}). You can now use handoff, delegate or spawn with it.` });
    expect((await w.projects()).find((p) => p.folders[0]?.path === repo)).toMatchObject({ name: basename(repo), folders: [{ path: repo, isGit: true }] });
  });

  it('a subfolder of a repository adds the repository, and says so', async () => {
    const w = await world();
    const repo = makeRepo();
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const { id, finished } = await w.call((t) => t.addProject({ path: sub, name: 'wren' }));
    expect((await w.answered(id, 'allow')).detail).toBe(`${repo}\nGit repository`);
    const result = await finished();
    expect(result.text).toBe(`${sub} is inside the git repository ${repo}, so the project is the repository's top level. Added wren (${repo}). You can now use handoff, delegate or spawn with it.`);
    expect((await w.projects()).find((p) => p.name === 'wren')!.folders[0]!.path).toBe(repo);
  });

  it('a plain folder registers as one, and a taken name gets the parent folder added', async () => {
    const w = await world();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-plain-')));
    const folder = join(parent, 'repoA');
    mkdirSync(folder);
    const { id, finished } = await w.call((t) => t.addProject({ path: folder }));
    const shown = await w.answered(id, 'allow');
    expect(shown.title).toBe(`Add repoA (${basename(parent)}) as a project?`);
    expect(shown.detail).toBe(`${folder}\nPlain folder, no git`);
    expect((await finished()).text).toMatch(/^Added repoA \(.+\) \(.+\)\. You can now use/);
    expect((await w.projects()).find((p) => p.folders[0]?.path === folder)).toMatchObject({ folders: [{ isGit: false }] });
  });

  it('a folder that is already a project answers with its name, without a card or a refusal', async () => {
    const w = await world();
    mkdirSync(join(w.a.folders[0]!.path, 'lib'));
    const { id, finished } = await w.call((t) => t.addProject({ path: join(w.a.folders[0]!.path, 'lib') }));
    expect(await finished()).toEqual({ text: 'Already a project: repoA' });
    expect(w.card(id)).toBeUndefined();
    expect(w.errorNotice(id)).toBeUndefined();
  });

  it('when the user says no, nothing is added and it is not an error', async () => {
    const w = await world();
    const repo = makeRepo();
    const { id, finished } = await w.call((t) => t.addProject({ path: repo }));
    await w.answered(id, 'deny');
    expect(await finished()).toEqual({ text: 'The user chose not to add it.' });
    expect((await w.projects()).some((p) => p.folders[0]?.path === repo)).toBe(false);
  });

  it('a linked worktree is refused in favour of its main checkout', async () => {
    const w = await world();
    const repo = makeRepo();
    const tree = join(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-wt-'))), 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const { id, finished } = await w.call((t) => t.addProject({ path: tree }));
    const result = await finished();
    expect(result).toEqual({ isError: true, text: `${tree} is a git worktree of ${repo}, not its main checkout. Call add_project with ${repo} instead.` });
    expect(w.card(id)).toBeUndefined();
    expect(w.errorNotice(id)).toMatch(/Kestrel refused add_project: .* is a git worktree of/);
  });

  describe('refuses, with a reason', () => {
    const refused = async (path: (w: Awaited<ReturnType<typeof world>>) => string) => {
      const w = await world();
      const { id, finished } = await w.call((t) => t.addProject({ path: path(w) }));
      const result = await finished();
      expect(result.isError).toBe(true);
      expect(w.card(id)).toBeUndefined();
      expect((await w.projects()).length).toBe(1);
      return result.text;
    };

    it('a path that does not exist', async () => {
      expect(await refused(() => '/no/such/folder/kestrel-test')).toBe('/no/such/folder/kestrel-test is not a directory that exists.');
    });

    it('a relative path', async () => {
      expect(await refused(() => 'Code/wren')).toMatch(/^Code\/wren is not an absolute path/);
    });

    it("a folder inside Kestrel's data folder", async () => {
      const text = await refused((w) => {
        const inside = join(w.data, 'worktrees', 'x');
        mkdirSync(inside, { recursive: true });
        return inside;
      });
      expect(text).toMatch(/inside Kestrel's own data folder/);
    });

    it('the home folder, also written as ~', async () => {
      expect(await refused(() => homedir())).toMatch(/is your home folder, which is too broad/);
      expect(await refused(() => '~')).toMatch(/is your home folder/);
    });

    it('the filesystem root', async () => {
      expect(await refused(() => '/')).toMatch(/^\/ is your filesystem root/);
    });
  });
});

describe('naming a folder that is not a project', () => {
  it('handoff to a folder on disk says to add it first; an unknown name lists the projects', async () => {
    const w = await world();
    const repo = makeRepo();
    const out: string[] = [];
    const { finished } = await w.call(async (t) => {
      for (const project of [repo, 'nowhere']) out.push((await t.handoff({ project, summary: 'x' })).text);
      return { text: 'done' };
    });
    await finished();
    expect(out[0]).toBe(`${repo} is a folder on this computer but not a Kestrel project yet. Call add_project with that path first, then try again.`);
    expect(out[1]).toMatch(/^No registered project "nowhere"\. Valid projects: repoA \(.+\)\.$/);
  });

});
