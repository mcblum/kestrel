// Issue 74 through the runtime: a session another session started is handed a live check (`outsideInherit`) built
// from the chain of sessions that started it (a delegate or handoff link, or the spawner its record keeps), and the
// switch kept with the always-allowed list. The rule itself is tested in shared/sandbox-inherit.test.ts; how each
// provider honours it in its adapter's tests (claude/sandbox-allow, codex/allow-list, opencode/decide).
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StartOptions } from '../agents/types.ts';
import type { PermissionLevel } from '../shared/permissions.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { FakeAgents, until, type Turn } from '../test-agent.ts';
import { makeRepo } from '../test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { Workspace } from '../workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-inherit-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const optionsOf = (prompt: string): StartOptions => agents.starts.find((s) => s.prompt === prompt)!.options;
  return { workspace, runtime, agents, a, settle, optionsOf };
}

/** Each turn whose text names a tool starts the next session with it, in Auto so no card waits. */
function starting(w: Awaited<ReturnType<typeof world>>) {
  w.agents.script = async (turn: Turn) => {
    if (turn.text === 'delegate') await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'child work' }] });
    if (turn.text === 'child work') await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'grandchild work' }] });
    if (turn.text === 'spawn') await turn.options.tools.spawn({ project: 'repoA', brief: 'spawned work' });
  };
}

async function started(w: Awaited<ReturnType<typeof world>>, prompt: string, permission: PermissionLevel) {
  starting(w);
  const root = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt, permission });
  await w.settle();
  return root;
}

describe('a session another session started, with the switch for such sessions (issue 74)', () => {
  it('a session the user started is handed no check: nothing started it', async () => {
    const w = await world();
    await started(w, 'delegate', 'auto');
    expect(w.optionsOf('delegate').outsideInherit).toBeUndefined();
  });

  it('a delegate of a session in Auto asks while the switch is off, and not once it is on, read as it is then', async () => {
    const w = await world();
    await started(w, 'delegate', 'auto');
    const check = w.optionsOf('child work').outsideInherit!;
    expect(check.allows()).toBe(false);
    expect(check.offerable()).toBe(true);
    await w.runtime.sandboxAllow.setInherit(true);
    expect(check.allows()).toBe(true);
    expect(check.offerable()).toBe(false);
    // Down a chain: the grandchild inherits while every session above it would not be asked.
    expect(w.optionsOf('grandchild work').outsideInherit!.allows()).toBe(true);
  });

  it('stops inheriting when a session above it leaves Auto', async () => {
    const w = await world();
    const root = await started(w, 'delegate', 'auto');
    await w.runtime.sandboxAllow.setInherit(true);
    const grandchild = w.optionsOf('grandchild work').outsideInherit!;
    expect(grandchild.allows()).toBe(true);
    await w.runtime.reply(root.id, 'carry on, but ask me', { permission: 'ask' });
    await w.settle();
    expect(grandchild.allows()).toBe(false);
    expect(grandchild.offerable()).toBe(false);
  });

  it('a child of a Manual session still asks, whatever the switch, and its card does not offer it', async () => {
    const w = await world();
    starting(w);
    const root = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'delegate', permission: 'ask' });
    // A Manual session asks before it delegates: allowed here.
    await until(() => w.runtime.overlay(root.id)?.messages.some((m) => m.input && !m.input.resolved) === true, 'the delegate card');
    const card = w.runtime.overlay(root.id)!.messages.find((m) => m.input && !m.input.resolved)!.input!;
    await w.runtime.answer(root.id, card.id, { optionId: 'allow' });
    await until(() => w.agents.starts.some((x) => x.prompt === 'child work'), 'the child starts');
    await w.runtime.sandboxAllow.setInherit(true);
    const check = w.optionsOf('child work').outsideInherit!;
    expect(w.optionsOf('child work').permission).toBe('ask');
    expect(check.allows()).toBe(false);
    expect(check.offerable()).toBe(false);
  });

  it('a spawned session, which no link names, inherits from the session that spawned it, after a restart too', async () => {
    const w = await world();
    await started(w, 'spawn', 'bypass');
    const options = w.optionsOf('spawned work');
    // A Bypass caller's child runs in Auto (childPermission), never Bypass.
    expect(options.permission).toBe('auto');
    expect(options.confineShell).toBe(true);
    expect(options.outsideInherit!.allows()).toBe(false);
    await w.runtime.sandboxAllow.setInherit(true);
    expect(options.outsideInherit!.allows()).toBe(true);
    const spawned = (await w.workspace.state()).sessions.find((s) => s.title === 'spawned work')!;
    const caller = (await w.workspace.state()).sessions.find((s) => s.title !== 'spawned work')!;
    expect((await w.workspace.storedDetail(spawned.id))?.spawnedBy).toBe(caller.id);
  });
});
