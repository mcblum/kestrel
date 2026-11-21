// When a role's first choice cannot run, and the session that leads (shared/who-does-what.ts,
// delegation.ts `runnerFor`, `passOn`, `giveTo`, `lead`): the part goes to the role's next
// choice, asked first unless the user chose otherwise, and a lead moves to the Orchestrate preset.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { cleanWhoDoesWhat, type WhoDoesWhat } from './shared/who-does-what.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const presets = [
  { id: 'astra', name: 'Astra', agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false },
  { id: 'opus', name: 'Deep', agent: 'claude', model: 'opus', effort: '', fast: false },
  { id: 'sonnet', name: 'Everyday', agent: 'claude', model: 'sonnet', effort: '', fast: false },
  { id: 'far', name: 'Far', agent: 'opencode', model: 'big', effort: '', fast: false },
];
const set = (extra: Record<string, unknown>): WhoDoesWhat => cleanWhoDoesWhat({ presets, roles: {}, instruction: '', whenUnavailable: 'auto', ...extra }, () => 'x');
const LIMIT = { type: 'failed' as const, reason: 'You have hit your usage limit', kind: 'other' as const };

async function world(who: WhoDoesWhat) {
  const workspace = new Workspace(memoryPersistence());
  const claude = new FakeAgents();
  const codex = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: claude.adapter(), codex: codex.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-fallback-'))));
  const project = await runtime.registerProject(makeRepo(), 'app');
  await runtime.whoDoesWhat.set(who);
  const results: { text: string; isError?: boolean }[] = [];
  /** What a Claude turn other than the lead's first does; the lead's first makes the delegate call. */
  let rest: (turn: (typeof claude.turns)[number]) => void | Promise<void> = () => undefined;
  const delegate = async (task: { brief: string; role?: string }, start: { model?: string; modelChosen?: boolean } = {}) => {
    claude.script = async (turn) => {
      if (turn.text === 'go') results.push(await turn.options.tools.delegate({ tasks: [{ project: 'app', ...task }] }));
      else await rest(turn);
    };
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go', permission: 'auto', ...start });
    return session;
  };
  const notices = (id: string) => runtime.overlay(id)?.messages.filter((m) => m.notice).map((m) => m.text) ?? [];
  const sessions = async () => (await workspace.state()).sessions;
  return { workspace, claude, codex, runtime, results, delegate, notices, sessions, onClaude: (fn: typeof rest) => void (rest = fn) };
}

describe('a role whose first choice is not connected', () => {
  it('goes to the next one in the user’s order, and says so', async () => {
    const { codex, results, delegate, notices } = await world(set({ roles: { design: 'far' }, fallbacks: { design: ['astra'] } }));
    const lead = await delegate({ brief: 'Restyle the inputs', role: 'design' });
    await until(() => codex.starts.length === 1, 'the design session on the fallback');
    expect(results[0]!.isError).toBeFalsy();
    expect(codex.starts[0]!.options).toMatchObject({ model: 'gpt-6.2-astra', effort: 'high' });
    expect(notices(lead.id).join('\n')).toContain('Design: "Far" (OpenCode · big) is not connected, so this part was given to "Astra" (Codex · gpt-6.2-astra · High).');
  });

  it('asks first, even in Auto, unless the user chose otherwise; and is refused when no fallback is connected either', async () => {
    const asking = await world(set({ roles: { design: 'far' }, fallbacks: { design: ['astra'] }, whenUnavailable: 'ask' }));
    const lead = await asking.delegate({ brief: 'Restyle the inputs', role: 'design' });
    await until(async () => (await asking.sessions()).find((s) => s.id === lead.id)?.state === 'attention', 'the card');
    expect(asking.codex.starts).toHaveLength(0);
    const card = asking.runtime.overlay(lead.id)!.messages.find((m) => m.input)!.input!;
    expect(card.detail).toContain('Design: Astra (Codex · gpt-6.2-astra · High), because "Far" is not connected');
    await asking.runtime.answer(lead.id, card.id, { optionId: 'allow' });
    await until(() => asking.codex.starts.length === 1, 'the design session, once approved');

    const none = await world(set({ roles: { design: 'far' } }));
    await none.delegate({ brief: 'Restyle', role: 'design' });
    await until(() => none.results.length === 1, 'the refusal');
    expect(none.results[0]!.text).toContain('Design work is set to run on "Far" (OpenCode · big), but OpenCode is not connected.');
  });
});

describe('a role’s session that runs out of usage', () => {
  it('is replaced by a session on the next choice, in the same worktree, told what happened', async () => {
    const { claude, codex, delegate, notices, sessions, runtime } = await world(set({ roles: { design: 'astra' }, fallbacks: { design: ['sonnet'] } }));
    codex.script = (turn) => turn.emit(LIMIT);
    const lead = await delegate({ brief: 'Restyle the inputs', role: 'design' });
    await until(() => claude.starts.length === 2, 'the replacement on Claude');
    const next = claude.starts[1]!;
    expect(next.options).toMatchObject({ model: 'sonnet' });
    expect(next.prompt).toContain('Another session ("Astra" (Codex · gpt-6.2-astra · High)) started this part and could not finish it. What it changed is already in this folder');
    expect(next.prompt).toMatch(/Restyle the inputs$/);
    const all = await sessions();
    expect(all).toHaveLength(3);
    const replacement = all.find((s) => s.agent === 'claude' && s.id !== lead.id)!;
    // The same worktree as the first: the lead's own.
    expect(runtime.recordOf(replacement.id)?.guest).toMatchObject({ hostId: lead.id, role: 'design', writes: true });
    expect(runtime.recordOf(replacement.id)?.roleRun).toEqual({ role: 'design', brief: 'Restyle the inputs', tried: ['astra', 'sonnet'] });
    expect(notices(lead.id).join('\n')).toContain('Design: "Astra" (Codex · gpt-6.2-astra · High) stopped with "You have hit your usage limit", so this part was given to "Everyday" (Claude · sonnet).');
  });

  it('carries on in the same session when the next choice is on the same agent', async () => {
    const { claude, delegate, sessions, onClaude } = await world(set({ roles: { build: 'opus' }, fallbacks: { build: ['sonnet'] } }));
    onClaude((turn) => (turn.options.model === 'opus' ? turn.emit(LIMIT) : undefined));
    await delegate({ brief: 'Wire it in', role: 'build' });
    await until(() => claude.turns.some((t) => t.options.model === 'sonnet'), 'the same session on the next model');
    const carried = claude.turns.find((t) => t.options.model === 'sonnet')!;
    expect(carried.text).toContain('Carry on with the part you were given from where you stopped');
    expect(await sessions()).toHaveLength(2);
  });

  it('asks where the work was handed out, and passes it on only on a yes', async () => {
    const { claude, codex, delegate, sessions, runtime } = await world(set({ roles: { design: 'astra' }, fallbacks: { design: ['sonnet'] }, whenUnavailable: 'ask' }));
    codex.script = (turn) => turn.emit(LIMIT);
    const lead = await delegate({ brief: 'Restyle the inputs', role: 'design' });
    const card = () => runtime.overlay(lead.id)?.messages.map((m) => m.input).find((i) => i?.id.startsWith('fallback-'));
    await until(() => card() !== undefined, 'the card');
    expect(card()!.title).toBe('Design cannot run on "Astra"');
    expect(card()!.detail).toContain('Next in your order for Design is "Everyday" (Claude · sonnet).');
    expect(claude.starts).toHaveLength(1);
    await runtime.answer(lead.id, card()!.id, { optionId: 'allow' });
    await until(() => claude.starts.length === 2, 'the replacement, once approved');
    expect(await sessions()).toHaveLength(3);
  });

  it('is not passed on for any other failure, and says so when there was nobody else', async () => {
    const crash = await world(set({ roles: { design: 'astra' }, fallbacks: { design: ['sonnet'] } }));
    crash.codex.script = (turn) => turn.emit({ type: 'failed', reason: 'TypeError: x is undefined', kind: 'other' });
    const lead = await crash.delegate({ brief: 'Restyle', role: 'design' });
    await until(() => crash.claude.turns.some((t) => t.text.includes('needs attention')), 'the lead told of the failure');
    expect(crash.claude.starts).toHaveLength(1);
    expect((await crash.sessions()).filter((s) => s.id !== lead.id)).toHaveLength(1);

    const alone = await world(set({ roles: { design: 'astra' } }));
    alone.codex.script = (turn) => turn.emit(LIMIT);
    await alone.delegate({ brief: 'Restyle', role: 'design' });
    await until(() => alone.claude.turns.some((t) => t.text.includes('needs attention')), 'the lead told');
    expect(alone.claude.turns.find((t) => t.text.includes('needs attention'))!.text).toContain('No other preset is set for Design, so nothing else was tried.');
  });
});

describe('the session that leads', () => {
  it('moves to the Orchestrate preset from its next turn when that is on its own agent', async () => {
    const { claude, delegate, notices } = await world(set({ orchestrate: 'opus' }));
    const lead = await delegate({ brief: 'Wire it in' });
    await until(() => claude.turns.some((t) => t.text.includes('Your delegated session')), 'the lead’s next turn');
    expect(claude.turns.find((t) => t.text.includes('Your delegated session'))!.options.model).toBe('opus');
    // The child keeps the model it was given: the lead's at the time.
    expect(claude.starts[1]!.options.model).not.toBe('opus');
    expect(notices(lead.id).join('\n')).toContain('This session now leads other sessions, so from its next turn it runs on "Deep" (Claude · opus), your Orchestrate preset.');
  });

  it('takes the first Orchestrate preset on its own agent, shown at once', async () => {
    const { claude, delegate, runtime } = await world(set({ orchestrators: ['astra', 'sonnet', 'opus'] }));
    const lead = await delegate({ brief: 'Wire it in' });
    await until(() => claude.turns.some((t) => t.text.includes('Your delegated session')), 'the lead’s next turn');
    expect(claude.turns.find((t) => t.text.includes('Your delegated session'))!.options.model).toBe('sonnet');
    expect(runtime.recordOf(lead.id)?.settings.model).toBe('sonnet');
  });

  it('keeps a model the user chose for the session, when starting it or since', async () => {
    const started = await world(set({ orchestrate: 'opus' }));
    const lead = await started.delegate({ brief: 'Wire it in' }, { model: 'sonnet', modelChosen: true });
    await until(() => started.claude.turns.some((t) => t.text.includes('Your delegated session')), 'the lead’s next turn');
    expect(started.claude.turns.find((t) => t.text.includes('Your delegated session'))!.options.model).toBe('sonnet');
    expect(started.notices(lead.id).filter((n) => n.includes('Orchestrate'))).toEqual([]);

    // Moved to the Orchestrate preset, then changed back by the user: it stays where they put it.
    const since = await world(set({ orchestrate: 'opus' }));
    const moved = await since.delegate({ brief: 'Wire it in' });
    await until(() => since.claude.turns.some((t) => t.text.includes('Your delegated session')), 'the lead’s next turn');
    await since.runtime.idle(moved.id);
    await since.runtime.reply(moved.id, 'and now?', { model: 'sonnet' });
    await since.runtime.idle(moved.id);
    expect(since.runtime.recordOf(moved.id)?.modelChosen).toBe(true);
    expect(since.claude.turns.at(-1)!.options.model).toBe('sonnet');
  });

  it('stays on its agent, and is told why once, when the preset is on another', async () => {
    const { claude, delegate, notices } = await world(set({ orchestrate: 'astra' }));
    const lead = await delegate({ brief: 'Wire it in' });
    await until(() => claude.turns.some((t) => t.text.includes('Your delegated session')), 'the lead’s next turn');
    expect(notices(lead.id).filter((n) => n.includes('Orchestrate preset'))).toEqual(['Your Orchestrate preset is "Astra" (Codex · gpt-6.2-astra · High), and a session keeps its agent, so this one stays the lead on Claude. To have Codex lead, start the task in a session on that preset, or add a Claude preset to Orchestrate.']);
  });
});
