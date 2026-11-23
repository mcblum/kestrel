// The changed-file refresh says why when it cannot read the worktree, instead of leaving the
// Changes pane on "No changes yet" while git status reports uncommitted files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import type { LivePatch, Session } from '../model.ts';
import type { Workspace } from '../workspace.ts';
import { newRecord } from './record.ts';
import { Upkeep } from './upkeep.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A repository with one commit and one uncommitted edit; returns its path and that commit. */
function repoWithEdit(): { path: string; head: string } {
  const path = mkdtempSync(join(tmpdir(), 'kestrel-upkeep-'));
  dirs.push(path);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(path, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(path, 'a.txt'), 'b\n');
  return { path, head: git('rev-parse', 'HEAD') };
}

function harness(path: string) {
  const session = { id: 's1', worktreePath: path, branch: 'main', landedIn: null, startedIn: null } as unknown as Session;
  const workspace = {
    state: async () => ({ sessions: [session] }),
    setLandedIn: async () => undefined,
    setBranch: async () => undefined,
    setDetail: async () => undefined,
  } as unknown as Workspace;
  const patches: LivePatch[] = [];
  const upkeep = new Upkeep(workspace, (_id, patch) => patches.push(patch), (_rec, work) => void work());
  return { upkeep, patches };
}

describe('Upkeep.refreshFiles', () => {
  test('a change found in the worktree is looked for by the other sessions working in it', async () => {
    const { path, head } = repoWithEdit();
    const session = { id: 'guest', worktreePath: path, branch: 'main', landedIn: null, startedIn: null } as unknown as Session;
    const host = { ...session, id: 'host' } as Session;
    const workspace = { state: async () => ({ sessions: [session, host] }), setLandedIn: async () => undefined, setBranch: async () => undefined, setDetail: async () => undefined } as unknown as Workspace;
    const hostRec = newRecord(null, head);
    const upkeep = new Upkeep(workspace, () => undefined, (_rec, work) => void work(), () => undefined, (id) => (id === 'guest' ? [['host', hostRec]] : []));
    const rec = newRecord(null, head);

    await upkeep.refreshFiles('guest', rec);
    await vi.waitFor(() => expect(hostRec.files.map((f) => f.path)).toEqual(['a.txt']), { timeout: 15_000 });
    upkeep.cancelTimers(rec);
    upkeep.cancelTimers(hostRec);
  });

  test('lists the edited file and reports no problem when git can read the worktree', async () => {
    const { path, head } = repoWithEdit();
    const { upkeep, patches } = harness(path);
    const rec = newRecord(null, head);

    await upkeep.refreshFiles('s1', rec);

    expect(rec.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(rec.filesProblem).toBeNull();
    expect(patches.some((p) => 'filesProblem' in p)).toBe(false);
  });

  test('says why, in git’s words, when the diff fails, and keeps the last list', async () => {
    const { path } = repoWithEdit();
    const { upkeep, patches } = harness(path);
    const rec = newRecord({ files: [{ path: 'old.txt', status: 'M', diff: '' }] }, '0000000000000000000000000000000000000bad');

    await upkeep.refreshFiles('s1', rec);

    expect(rec.files.map((f) => f.path)).toEqual(['old.txt']);
    expect(rec.filesProblem).toMatch(/git diff failed/);
    expect(patches).toContainEqual({ filesProblem: rec.filesProblem });
  });

  test('says there is no base instead of returning silently', async () => {
    const { path } = repoWithEdit();
    const { upkeep, patches } = harness(path);
    const rec = newRecord(null, null);

    await upkeep.refreshFiles('s1', rec);

    expect(rec.filesProblem).toMatch(/cannot find the commit/);
    expect(patches).toContainEqual({ filesProblem: rec.filesProblem });
  });

  test('clears the problem once the list can be read again', async () => {
    const { path, head } = repoWithEdit();
    const { upkeep, patches } = harness(path);
    const rec = newRecord({ filesProblem: 'earlier failure' }, head);

    await upkeep.refreshFiles('s1', rec);

    expect(rec.filesProblem).toBeNull();
    expect(patches).toContainEqual({ filesProblem: null });
  });
});
