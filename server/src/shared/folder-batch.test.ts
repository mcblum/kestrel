import { describe, expect, test } from 'vitest';
import { addLabel, allSelectable, batchSummary, defaultSelection, failedPaths, toggled, worktreeNote, type BatchOutcome, type ListedFolder } from './folder-batch.ts';

const entry = (name: string, over: Partial<ListedFolder> = {}): ListedFolder => ({ name, path: `/code/${name}`, isGit: false, readable: true, project: null, problem: null, worktreeOf: null, proposedName: name, ...over });
const folders = [
  entry('api', { isGit: true }),
  entry('notes'),
  entry('shop', { isGit: true, project: { id: 'p', name: 'Shop' }, proposedName: null }),
  entry('secret', { isGit: false, readable: false, proposedName: null }),
  entry('web', { isGit: true }),
];

describe('choosing folders', () => {
  test('ticks the git repositories that are not projects yet; plain, registered and unreadable ones are not', () => {
    expect(defaultSelection(folders)).toEqual(['/code/api', '/code/web']);
  });

  test('a linked worktree is not ticked for you, but All takes it and its row says what it is', () => {
    const side = entry('api-side', { isGit: true, worktreeOf: { path: '/code/api', name: 'api', project: null } });
    expect(defaultSelection([...folders, side])).toEqual(['/code/api', '/code/web']);
    expect(allSelectable([...folders, side])).toContain('/code/api-side');
    expect(worktreeNote(side)).toBe('Worktree of api');
    expect(worktreeNote(entry('x', { worktreeOf: { path: '/code/api', name: 'api', project: { id: 'p', name: 'API server' } } }))).toBe('Worktree of api, the project API server');
    expect(worktreeNote(entry('y'))).toBeNull();
  });

  test('All ticks every folder that can be added, in listing order', () => {
    expect(allSelectable(folders)).toEqual(['/code/api', '/code/notes', '/code/web']);
  });

  test('toggling keeps listing order', () => {
    expect(toggled(folders, ['/code/web'], '/code/api')).toEqual(['/code/api', '/code/web']);
    expect(toggled(folders, ['/code/api', '/code/web'], '/code/api')).toEqual(['/code/web']);
  });

  test('the button says how many', () => {
    expect([addLabel(0), addLabel(1), addLabel(7)]).toEqual(['Add projects', 'Add 1 project', 'Add 7 projects']);
  });
});

describe('after a batch', () => {
  const project = { id: 'x', name: 'api', folders: [], defaultFolderId: null };
  const added: BatchOutcome = { path: '/code/api', ok: true, project };
  const failed: BatchOutcome = { path: '/code/notes', ok: false, error: 'no' };

  test('the failed ones stay ticked', () => {
    expect(failedPaths([added, failed])).toEqual(['/code/notes']);
  });

  test('one line says what was added and what was not', () => {
    expect(batchSummary([added])).toBe('Added 1 project.');
    expect(batchSummary([added, failed])).toBe('Added 1 project. 1 folder was not added; the reason is under it.');
    expect(batchSummary([failed, failed])).toBe('2 folders were not added; the reason is under each.');
  });
});
