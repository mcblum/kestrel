import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { SessionView, WorkspaceState } from './model.ts';
import { folderBytes, worktreeList, type CleanupDeps } from './worktree-cleanup.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-cleanup-')));
const folder = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

let n = 0;
const session = (over: Partial<SessionView>): SessionView =>
  ({ id: `s${++n}`, title: `Session ${n}`, agent: 'claude', state: 'done', note: '', startedIn: 'p1', startedFolderId: null, folderId: null, landedIn: null, worktreePath: null, branch: null, worktreeDiscarded: false, groupId: null, createdAt: 0, updatedAt: now - 2 * DAY, lastActivityAt: now - 2 * DAY, filing: { projectId: 'p1', status: 'started', discarded: false }, tags: [], request: null, ...over }) as SessionView;

function deps(sessions: SessionView[], archived: SessionView[] = [], uncommitted: Record<string, string[]> = {}): CleanupDeps {
  const state = { projects: [{ id: 'p1', name: 'Platform', folders: [] }], sessions, archived: { sessions: archived, projects: [], groups: [] } } as unknown as WorkspaceState;
  return {
    state: async () => state,
    now: () => now,
    checkoutOf: (s) => (s.title === 'No checkout' ? null : '/repo'),
    preview: async (_checkout, worktree, branch) => ({ branch, worktree, uncommitted: uncommitted[worktree] ?? [], target: 'main', unmerged: [], totalUnmerged: worktree.endsWith('ahead') ? 3 : 0 }),
    measure: async (path) => (path.endsWith('big') ? 5 * 1024 ** 3 : 1024 ** 2),
  };
}

describe('the list of session worktrees', () => {
  test('lists the worktrees still on disk with why each is suggested, the suggested ones first', async () => {
    const merged = session({ title: 'Merged', worktreePath: folder('merged'), branch: 'a', request: 'merged' });
    const dirty = session({ title: 'Merged, dirty', worktreePath: folder('dirty'), branch: 'b', request: 'merged' });
    const idle = session({ title: 'Old', worktreePath: folder('big'), branch: 'c', lastActivityAt: now - 30 * DAY, updatedAt: now - 30 * DAY });
    const fresh = session({ title: 'Fresh', worktreePath: folder('ahead'), branch: 'd' });
    const working = session({ title: 'Working', worktreePath: folder('working'), branch: 'e', state: 'running', request: 'merged' });
    const gone = session({ title: 'Gone', worktreePath: join(root, 'not-there'), branch: 'f', request: 'merged' });
    const discarded = session({ title: 'Discarded', worktreePath: folder('discarded'), branch: 'g', worktreeDiscarded: true });
    const main = session({ title: 'Main checkout' });
    const archived = session({ title: 'Archived', worktreePath: folder('archived'), branch: 'h' });
    const list = await worktreeList(deps([merged, dirty, idle, fresh, working, gone, discarded, main], [archived], { [dirty.worktreePath!]: ['a.txt', 'b.txt'] }));
    expect(list.rows.map((r) => [r.title, r.reason, r.safe, r.uncommitted, r.unmerged])).toEqual([
      ['Merged', 'merged', true, 0, 0],
      ['Merged, dirty', 'merged', false, 2, 0],
      ['Archived', 'archived', true, 0, 0],
      ['Old', 'idle', true, 0, 0],
      ['Fresh', null, false, 0, 3],
      ['Working', null, false, 0, 0],
    ]);
    expect(list.rows[0]).toMatchObject({ project: 'Platform', path: merged.worktreePath, branch: 'a', bytes: 1024 ** 2 });
    expect(list.summary).toEqual({ stale: { count: 4, bytes: 3 * 1024 ** 2 + 5 * 1024 ** 3 }, safe: { count: 3, bytes: 2 * 1024 ** 2 + 5 * 1024 ** 3 } });
  });

  test('a worktree git could not be asked about is listed but never offered with the others', async () => {
    const lost = session({ title: 'No checkout', worktreePath: folder('lost'), branch: 'x', request: 'merged' });
    const failing = { ...deps([session({ title: 'Git fails', worktreePath: folder('failing'), branch: 'y', request: 'merged' }), lost]), preview: async () => Promise.reject(new Error('not a repository')) };
    expect((await worktreeList(failing)).rows.map((r) => [r.title, r.reason, r.safe])).toEqual([
      ['Git fails', 'merged', false],
      ['No checkout', 'merged', false],
    ]);
  });

  test('measures a real folder, and says nothing for one that is not there', async () => {
    const dir = folder('measured');
    writeFileSync(join(dir, 'file.bin'), Buffer.alloc(64 * 1024));
    expect(await folderBytes(dir)).toBeGreaterThanOrEqual(64 * 1024);
    expect(await folderBytes(join(root, 'nope'))).toBeNull();
  });
});
