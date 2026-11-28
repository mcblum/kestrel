// A worker node pushes a session's branch when a turn ends (worker-nodes.md 9.3), against a real bare repository in a
// temporary folder standing in for `origin`; a `pre-receive` hook stands in for a host that refuses. No network.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../model.ts';
import { NodeProjectPrefsStore } from '../project-clone/prefs.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { GIT_TEST_TIMEOUT_MS } from '../test-timeouts.ts';
import { NodePusher } from './node-push.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', file);
};

/** A bare `origin` with main, and a clone of it on the session's branch with one commit `origin` lacks. */
function repo(branch = 'kestrel/fix-login') {
  const bare = join(tempDir('origin'), 'shop.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = join(tempDir('seed'), 'shop');
  execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'ignore' });
  commit(seed, 'readme.txt');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const work = join(tempDir('wt'), 'shop');
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'checkout', '-q', '-B', branch);
  commit(work, 'fix.txt');
  return { bare, work };
}

const session = (over: Partial<Session>): Session => ({ id: 's1', title: 'Fix login', agent: 'claude', state: 'done', note: '', startedIn: 'p1', startedFolderId: null, landedIn: 'p1', worktreePath: null, branch: 'kestrel/fix-login', worktreeDiscarded: false, groupId: null, createdAt: 0, updatedAt: 0, ...over });

function pusher(s: Session, opts: { kind?: KestrelKind; keptOff?: readonly string[]; prefs?: NodeProjectPrefsStore } = {}) {
  const notices: string[] = [];
  const p = new NodePusher({ kind: opts.kind ?? 'node', sessions: async () => [s], prefs: opts.prefs ?? new NodeProjectPrefsStore(), keptOff: () => opts.keptOff ?? [], notice: (_id, text) => notices.push(text), now: () => 42 });
  return { p, notices };
}

describe('a node pushes a session’s branch when a turn ends', () => {
  it('pushes the branch to the same name on origin, and then has nothing more to push', async () => {
    const { bare, work } = repo();
    const s = session({ worktreePath: work });
    const { p, notices } = pusher(s);
    expect(await p.on()).toBe(true);
    await p.turnOver('s1');
    expect(git(bare, 'rev-parse', 'refs/heads/kestrel/fix-login')).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(bare, 'rev-parse', 'main')).not.toBe(git(work, 'rev-parse', 'HEAD'));
    expect(notices).toEqual([]);
    expect(await p.stepFor(s)).toEqual({ push: false, why: 'nothing' });
  });

  it('never on a desktop, with the setting off, for a project kept off, or for a guest', async () => {
    const { bare, work } = repo();
    const off = new NodeProjectPrefsStore();
    await off.set({ push: false });
    for (const [s, opts] of [
      [session({ worktreePath: work }), { kind: 'app' as const }],
      [session({ worktreePath: work }), { prefs: off }],
      [session({ worktreePath: work }), { keptOff: ['p1'] }],
      [session({ worktreePath: work, hostId: 'host' }), {}],
    ] as const) {
      const { p } = pusher(s, opts);
      await p.turnOver('s1');
    }
    expect(git(bare, 'branch', '--list')).not.toContain('kestrel/fix-login');
  });

  it('never the base branch', async () => {
    const { bare, work } = repo('main');
    const before = git(bare, 'rev-parse', 'main');
    const s = session({ worktreePath: work, branch: 'main' });
    const { p } = pusher(s);
    expect(await p.stepFor(s)).toEqual({ push: false, why: 'base' });
    await p.turnOver('s1');
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('says a refused push in the session with git’s own line, tells of it once, and clears it when a push goes through', async () => {
    const { bare, work } = repo();
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "pushes are closed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const { p, notices } = pusher(session({ worktreePath: work }));
    const told: number[] = [];
    p.onChange(() => told.push(p.failures().length));
    await p.turnOver('s1');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Could not push `kestrel\/fix-login` to `origin`: \S/);
    expect(p.failures()).toEqual([{ sessionId: 's1', title: 'Fix login', key: 's1\n42', text: notices[0] }]);
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    await p.turnOver('s1');
    expect(p.failures()).toEqual([]);
    expect(told).toEqual([1, 0]);
  });

  it('nothing for a repository with no origin', async () => {
    const { work } = repo();
    git(work, 'remote', 'remove', 'origin');
    const s = session({ worktreePath: work });
    expect(await pusher(s).p.stepFor(s)).toEqual({ push: false, why: 'no-origin' });
  });
});
