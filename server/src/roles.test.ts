// Roles in a delegate (shared/who-does-what.ts, delegation.ts `runnerFor`, agents/instruction.ts
// `rolesText`): work of a kind the user gave an agent goes to that agent's preset, whichever agent
// asked, and every agent is told so in the same words.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { rolesText, standingInstruction } from './agents/instruction.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { NOBODY, type WhoDoesWhat } from './shared/who-does-what.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const who: WhoDoesWhat = {
  presets: [
    { id: 'astra', name: 'Astra', agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false },
    { id: 'quick', name: 'Quick', agent: 'claude', model: 'haiku', effort: '', fast: true },
  ],
  roles: { design: 'astra', build: null, review: 'quick' },
  instruction: 'Anything visual goes to Design first.',
};
const t = (name: string) => `kestrel_${name}`;

describe('what every agent is told', () => {
  it('names each role that has an agent, how to send it work, and the user’s own words', () => {
    const text = rolesText(who, t);
    expect(text).toContain('call `kestrel_delegate` with a task for it and the role below');
    expect(text).toContain('- Design (visual work: layout, styling, a component’s look): "Astra", Codex · gpt-6.2-astra · High. Pass `role: "design"`.');
    expect(text).toContain('- Review (reviewing another agent’s work before a pull request): "Quick", Claude · haiku · Fast. Pass `role: "review"`.');
    expect(text).not.toContain('- Build');
    expect(text).toContain('The user adds, in their own words: Anything visual goes to Design first.');
  });

  it('says only the user’s words when no role has an agent, and nothing when there is nothing', () => {
    expect(rolesText({ ...NOBODY, instruction: 'Keep changes small.' }, t)).toBe('On who does what, the user says, in their own words: Keep changes small.');
    expect(rolesText(NOBODY, t)).toBe('');
    expect(rolesText(undefined, t)).toBe('');
  });

  it('is part of the standing instruction, after where changes are made', () => {
    const base = { toolName: t, projects: [], workspace: { kind: 'scratch' as const } };
    expect(standingInstruction({ ...base, who })).toContain('Who does what: the user has chosen');
    expect(standingInstruction(base)).not.toContain('Who does what');
  });
});

describe('a delegate with a role', () => {
  async function world() {
    const workspace = new Workspace(memoryPersistence());
    const claude = new FakeAgents();
    const codex = new FakeAgents();
    const runtime = new SessionRuntime(workspace, { claude: claude.adapter(), codex: codex.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-roles-'))));
    const project = await runtime.registerProject(makeRepo(), 'app');
    await runtime.whoDoesWhat.set(who);
    const results: { text: string; isError?: boolean }[] = [];
    /** A Claude session in Auto (no approval card) whose first turn makes this delegate call. */
    const delegate = async (task: { brief: string; role?: string; agent?: string }) => {
      claude.script = async (turn) => {
        if (turn.text === 'go') results.push(await turn.options.tools.delegate({ tasks: [{ project: 'app', ...task }] }));
      };
      const before = results.length;
      const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go', permission: 'auto' });
      await until(() => results.length > before, 'the delegate call');
      return session;
    };
    return { workspace, claude, codex, runtime, results, delegate };
  }

  it('starts the part on the role’s agent, model and effort, whichever agent asked', async () => {
    const { workspace, codex, results, delegate } = await world();
    const parent = await delegate({ brief: 'Restyle the inputs', role: 'design' });
    await until(() => codex.starts.length === 1, 'the design session');
    expect(results[0]!.isError).toBeFalsy();
    expect(codex.starts[0]!.options).toMatchObject({ model: 'gpt-6.2-astra', effort: 'high' });
    // In the caller's own project the part is done in the caller's worktree, and is told so before its brief (worktree-guests.test.ts).
    expect(codex.starts[0]!.prompt).toMatch(/Restyle the inputs$/);
    const child = (await workspace.state()).sessions.find((s) => s.id !== parent.id)!;
    expect(child.agent).toBe('codex');
  });

  it('uses the role’s preset over a named agent, and passes fast mode', async () => {
    const { claude, results, delegate } = await world();
    await delegate({ brief: 'Review the diff', role: 'review', agent: 'codex' });
    await until(() => claude.starts.length === 2, 'the review session');
    expect(results[0]!.isError).toBeFalsy();
    expect(claude.starts[1]!.options).toMatchObject({ model: 'haiku', fast: true });
  });

  it('leaves a role with no preset to the caller’s own agent', async () => {
    const { claude, codex, delegate } = await world();
    await delegate({ brief: 'Wire it in', role: 'build' });
    await until(() => claude.starts.length === 2, 'the build session');
    expect(codex.starts).toHaveLength(0);
  });

  it('refuses a role it does not know, and one whose agent is not connected, with what to do', async () => {
    const { runtime, results, delegate } = await world();
    await delegate({ brief: 'x', role: 'marketing' });
    expect(results[0]!.text).toContain('Unknown role "marketing". Use one of: design, build, review; or leave it out.');
    await runtime.whoDoesWhat.set({ ...who, presets: [{ ...who.presets[0]!, agent: 'opencode' }, who.presets[1]!] });
    await delegate({ brief: 'Restyle', role: 'design' });
    expect(results[1]!.text).toContain('Design work is set to run on "Astra" (OpenCode · gpt-6.2-astra · High), but OpenCode is not connected.');
  });
});
