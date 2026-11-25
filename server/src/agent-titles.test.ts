// The title an agent gives each session it starts (shared/agent-title.ts): used as given, checked
// before anything is started or asked, kept from the title call, and the brief titles it when none
// is given, skipping a leading ticket key and address.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TitleProvider } from './agents/title-providers.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const LH = 'LH-140850 https://acme.atlassian.net/browse/LH-140850. Create the Cognito OAuth client in Terraform.';

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-titles-')));
  const agents = new FakeAgents();
  const asked: string[] = [];
  // The title call answers every prompt with the same generated title.
  const provider: TitleProvider = { name: 'test', agent: 'claude', title: async (prompt) => (asked.push(prompt), 'Generated title') };
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { titleProviders: [provider] });
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  await runtime.registerProject(makeRepo(), 'repoB');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const results: { text: string; isError?: boolean }[] = [];
  const titles = async () => (await workspace.state()).sessions.map((s) => s.title);
  return { workspace, agents, runtime, a, settle, results, titles, asked };
}

describe('titles an agent gives the sessions it starts', () => {
  it('names each delegated session as given, shows the titles on the card, and the title call leaves them be', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'split') w.results.push(await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: LH, title: '  Terraform:  Cognito OAuth client ' }, { project: 'repoB', brief: `${LH} Then the UI.`, title: 'Login page' }] }));
    };
    const lead = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'split', permission: 'edits' });
    const open = () => w.runtime.overlay(lead.id)!.messages.find((m) => m.input && !m.input.resolved)?.input;
    await until(() => open() !== undefined, 'the approval card');
    const card = open()!;
    expect(card.detail).toMatch(/^• Terraform: Cognito OAuth client · repoA/m);
    expect(card.detail).toMatch(/^• Login page · repoB/m);
    await w.runtime.answer(lead.id, card.id, { optionId: 'allow' });
    await w.settle();
    expect(await w.titles()).toEqual(expect.arrayContaining(['Terraform: Cognito OAuth client', 'Login page']));
    expect(await w.titles()).not.toContain('Generated title');
  });

  it('refuses titles that repeat each other, are only a ticket key or hold an address, before starting or asking anything', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text !== 'try') return;
      w.results.push(await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'one', title: 'API' }, { project: 'repoB', brief: 'two', title: 'api' }] }));
      w.results.push(await turn.options.tools.spawn({ project: 'repoB', brief: 'x', title: 'LH-140850' }));
      w.results.push(await turn.options.tools.handoff({ project: 'repoB', summary: 'x', title: 'See https://acme.atlassian.net/browse/LH-1' }));
    };
    const caller = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'try', permission: 'edits' });
    await w.settle();
    expect(w.results.map((r) => r.isError)).toEqual([true, true, true]);
    expect(w.results[0]!.text).toMatch(/Tasks 1 and 2 are both titled "api"/);
    expect(w.results[1]!.text).toMatch(/is only a ticket key/);
    expect(w.results[2]!.text).toMatch(/contains an address/);
    expect((await w.workspace.state()).sessions.map((s) => s.id)).toEqual([caller.id]);
    expect(w.runtime.overlay(caller.id)!.messages.some((m) => m.input)).toBe(false);
  });

  it('with no title, titles the session from its brief without the ticket key and address, and lets the title call improve it', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'go') w.results.push(await turn.options.tools.spawn({ project: 'repoB', brief: LH }));
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go', permission: 'auto' });
    await until(() => w.results.length > 0, 'the spawn result');
    expect(w.results[0]!.text).toMatch(/^Started a separate session "Create the Cognito OAuth client in Terraform\." /);
    await w.settle();
    // A fallback is provisional, as before: the title call may replace it.
    expect(w.asked).toContain(LH);
  });

  it('names a handoff and a spawn as given', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text !== 'go') return;
      w.results.push(await turn.options.tools.spawn({ project: 'repoB', brief: LH, title: 'Cognito client' }));
      w.results.push(await turn.options.tools.handoff({ project: 'repoB', summary: LH, title: 'OAuth hand-over' }));
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go', permission: 'auto' });
    await w.settle();
    expect(w.results.map((r) => r.isError ?? false)).toEqual([false, false]);
    expect(await w.titles()).toEqual(expect.arrayContaining(['Cognito client', 'OAuth hand-over']));
    expect(w.asked).not.toContain(LH);
  });
});
