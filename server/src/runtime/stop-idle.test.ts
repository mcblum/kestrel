// Stop on a session with nothing running (runtime/turns.ts `settleIdle`): a failed session reads as
// still at work, so the menu offers Stop and holds Archive back; Stop must then put it to rest.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { FakeAgents, until } from '../test-agent.ts';
import { makeRepo } from '../test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { Workspace } from '../workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

describe('Stop on a session with nothing running', () => {
  it('settles a failed session as stopped, so it can be archived, and refuses one that is finished', async () => {
    const workspace = new Workspace(memoryPersistence());
    const claude = new FakeAgents();
    const runtime = new SessionRuntime(workspace, { claude: claude.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-stop-idle-'))));
    const project = await runtime.registerProject(makeRepo(), 'app');
    const stateOf = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
    claude.script = () => {
      throw new Error('The model is not supported');
    };
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Go', permission: 'auto' });
    await until(async () => (await stateOf(session.id)).state === 'attention', 'the session to fail');

    await runtime.stop(session.id);
    expect(await stateOf(session.id)).toMatchObject({ state: 'done', note: 'Stopped', stopped: true });
    // Nothing left to stop: said, as before.
    await expect(runtime.stop(session.id)).rejects.toThrow('This session is not running.');
  });
});
