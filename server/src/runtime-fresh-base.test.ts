// New sessions start from the latest base (base-refresh.ts) through the runtime: a session the user
// starts and a child both get a worktree at the upstream's tip with a notice; with the setting off
// no fetch runs; a plain folder is never fetched for.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { runGitFetch, type FetchRunner } from './base-refresh.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));

/** A checkout one commit behind its upstream on a local bare repository. Returns the upstream's tip. */
function behindItsRemote(): { repo: string; tip: string; local: string } {
  const bare = join(tempDir('remote'), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const other = join(tempDir('other'), 'clone');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore' });
  writeFileSync(join(other, 'b.txt'), 'newer\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'newer');
  git(other, 'push', '-q', 'origin', 'main');
  return { repo, tip: git(other, 'rev-parse', 'HEAD'), local: git(repo, 'rev-parse', 'HEAD') };
}

function world() {
  const calls: string[] = [];
  const baseFetch: FetchRunner = (repo, args, timeoutMs) => {
    calls.push(repo);
    return runGitFetch(repo, args, timeoutMs);
  };
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, tempDir('data'), { baseFetch });
  const view = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
  const notices = (id: string) => runtime.overlay(id)!.messages.filter((m) => m.notice).map((m) => m.text);
  return { workspace, agents, runtime, calls, view, notices };
}

describe('a new session in a git project', () => {
  it('starts from the upstream tip and says so; a child is cut the same way', async () => {
    const w = world();
    const { repo, tip, local } = behindItsRemote();
    const project = await w.runtime.registerProject(repo);
    const session = await w.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await until(async () => (await w.view(session.id)).worktreePath !== null, 'the worktree');
    await w.runtime.idle(session.id);
    expect(git((await w.view(session.id)).worktreePath!, 'rev-parse', 'HEAD')).toBe(tip);
    expect(w.notices(session.id)).toContain('Started from the latest main (1 commit newer than the local one).');

    const child = await w.workspace.addSession({ title: 'Child work', agent: 'claude', startedIn: project.id, state: 'running' });
    expect(await w.runtime.launchChild(child, project, project.folders[0]!, 'do part', 'delegate', '', 'ask')).toEqual({ ok: true });
    expect(git((await w.view(child.id)).worktreePath!, 'rev-parse', 'HEAD')).toBe(tip);
    // The second fetch of the same branch, moments later, was the first one's answer.
    expect(w.calls).toEqual([repo]);
    expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(local);
  });

  it('runs no fetch with the setting off, and starts from the checkout as before', async () => {
    const w = world();
    const { repo, local } = behindItsRemote();
    await w.runtime.gitPrefs.setStartFromLatest(false);
    const project = await w.runtime.registerProject(repo);
    const session = await w.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await until(async () => (await w.view(session.id)).worktreePath !== null, 'the worktree');
    await w.runtime.idle(session.id);
    expect(git((await w.view(session.id)).worktreePath!, 'rev-parse', 'HEAD')).toBe(local);
    expect(w.notices(session.id)).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it('never fetches for a plain folder', async () => {
    const w = world();
    const folder = tempDir('plain');
    const project = await w.runtime.registerProject(folder);
    const session = await w.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await w.runtime.idle(session.id);
    expect((await w.view(session.id)).worktreePath).toBeNull();
    expect(w.calls).toEqual([]);
  });
});
