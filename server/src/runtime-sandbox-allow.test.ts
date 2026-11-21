// The always-allowed list through the runtime: a session's agent is handed it, an "Always allow"
// choice on a card adds the card's own offer and allows the request, and nothing an agent can call
// reaches it.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, InputAnswer, InputRequest } from './agents/types.ts';
import { KESTREL_TOOLS } from './agents/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { Workspace } from './workspace.ts';

const request = (offer: InputRequest['sandboxOffer']): InputRequest => ({
  id: 'b1',
  kind: 'approval',
  tool: 'Bash',
  title: 'Run git commit (outside the sandbox)',
  detail: 'git commit -S -m x',
  options: [{ id: 'allow', label: 'Allow', role: 'allow' }, { id: 'always-command', label: 'Always allow this command: git commit', role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }],
  ...(offer ? { sandboxOffer: offer } : {}),
});

async function started(offer: InputRequest['sandboxOffer']) {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  agents.hold = true;
  agents.script = (turn) => turn.emit({ type: 'needs-input', request: request(offer) });
  const answers: InputAnswer[] = [];
  const base = agents.adapter();
  // The fake agent's handle, recording what the runtime passes on.
  const adapter: AgentAdapter = { ...base, start: (o, p, e, a) => ({ ...base.start(o, p, e, a), answer: (_id, answer) => void answers.push(answer) }) };
  const runtime = new SessionRuntime(workspace, { claude: adapter }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-allow-rt-'))));
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'commit' });
  await until(() => agents.starts.length > 0 && agents.turns.length > 0, 'the card');
  await until(async () => (await runtime.snapshot(session.id))?.messages?.some((m) => m.input?.id === 'b1') ?? false, 'the card in the transcript');
  return { runtime, agents, answers, session };
}

describe('the always-allowed list in the runtime', () => {
  it('is handed to every session’s agent, as it stands at each use', async () => {
    const w = await started({ command: ['git', 'commit'] });
    const access = w.agents.starts[0]!.options.sandboxAllow!;
    expect(access.entries()).toEqual([]);
    await w.runtime.sandboxAllow.addCommand('gpg');
    expect(access.entries()).toEqual([{ kind: 'command', words: ['gpg'] }]);
  });

  it('adds the card’s offer when the user picks "Always allow this command", and allows the request', async () => {
    const w = await started({ command: ['git', 'commit'] });
    await w.runtime.answer(w.session.id, 'b1', { optionId: 'always-command' });
    expect(w.answers).toEqual([{ optionId: 'allow' }]);
    expect(await w.runtime.sandboxAllow.entries()).toEqual([{ kind: 'command', words: ['git', 'commit'] }]);
  });

  it('refuses the choice on a card that offered nothing, and the card keeps waiting', async () => {
    const w = await started(undefined);
    await expect(w.runtime.answer(w.session.id, 'b1', { optionId: 'always-command' })).rejects.toThrow(/does not offer/);
    expect(w.answers).toEqual([]);
    expect(await w.runtime.sandboxAllow.entries()).toEqual([]);
    await w.runtime.answer(w.session.id, 'b1', { optionId: 'allow' });
    expect(w.answers).toEqual([{ optionId: 'allow' }]);
  });

  it('cannot be reached by an agent: no Kestrel tool and nothing in the tool host adds to it', async () => {
    const w = await started({ command: ['git', 'commit'] });
    expect(KESTREL_TOOLS.filter((t) => /sandbox|allow/i.test(t))).toEqual([]);
    const options = w.agents.starts[0]!.options;
    expect(Object.keys(options.tools).filter((k) => /sandbox|allow/i.test(k))).toEqual([]);
    // What the agent is handed only reads the list.
    expect(Object.keys(options.sandboxAllow!).sort()).toEqual(['entries', 'offer']);
    await options.sandboxAllow!.offer('git commit', { cwd: '/w', home: '/h', folders: ['/w'] });
    expect(await w.runtime.sandboxAllow.entries()).toEqual([]);
  });
});
