// Discarding a session's worktree from the runtime: the folder goes, the session stays listed as
// discarded, and it can no longer take a reply (it would otherwise fall back to the main checkout).
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { createProject } from './project-store.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function started() {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-discard-'))));
  const repo = makeRepo();
  const project = await createProject(workspace, { name: 'Shop', folders: [repo] });
  const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'work' });
  const view = async () => (await workspace.state()).sessions.find((s) => s.id === session.id)!;
  await until(async () => (await view()).worktreePath !== null, 'the worktree');
  await agents.settled();
  await runtime.idle(session.id);
  return { workspace, runtime, repo, session, view };
}

describe('discarding a worktree', () => {
  it('removes the folder, marks the session, and refuses a reply with a reason', async () => {
    const w = await started();
    const before = await w.view();
    expect((await w.runtime.checkoutOf(w.session.id)).checkout).toBe(w.repo);
    await w.runtime.discardWorktree(w.session.id, false);
    expect(existsSync(before.worktreePath!)).toBe(false);
    expect(await w.view()).toMatchObject({ worktreePath: null, worktreeDiscarded: true });
    await expect(w.runtime.reply(w.session.id, 'more', {})).rejects.toThrow(/was discarded, so it cannot continue/);
    await expect(w.runtime.discardWorktree(w.session.id, false)).rejects.toThrow(/already discarded/);
  });
});
