import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFolderQueue, foldersInArgs, foldersOnly } from './open-folders.mjs';

describe('foldersOnly', () => {
  const dirs = new Set(['/Users/me/Code/site', '/Users/me/Code/api']);
  const isDir = (p) => dirs.has(p);

  test('keeps folders and drops files quietly', () => {
    assert.deepEqual(foldersOnly(['/Users/me/Code/site', '/Users/me/notes.txt', '/Users/me/Code/api'], isDir), ['/Users/me/Code/site', '/Users/me/Code/api']);
  });
  test('drops repeats and empty paths', () => {
    assert.deepEqual(foldersOnly(['/Users/me/Code/site', '', '/Users/me/Code/site'], isDir), ['/Users/me/Code/site']);
  });
  test('reads the disk by default: a missing path is not a folder', () => {
    assert.deepEqual(foldersOnly(['/definitely/not/here/kestrel']), []);
  });
});

describe('createFolderQueue', () => {
  test('holds folders until taken, then is empty', () => {
    const queue = createFolderQueue();
    queue.add(['/a']);
    queue.add(['/b', '/a']);
    assert.equal(queue.size, 2);
    assert.deepEqual(queue.take(), ['/a', '/b']);
    assert.deepEqual(queue.take(), []);
  });
  test('a take hands over a copy that later adds do not change', () => {
    const queue = createFolderQueue();
    queue.add(['/a']);
    const taken = queue.take();
    queue.add(['/b']);
    assert.deepEqual(taken, ['/a']);
  });
});

describe('foldersInArgs (Windows and Linux: folders named on the command line)', () => {
  const isDir = (path) => path.endsWith('repo') || path.endsWith('other');

  test('takes the folders after the program, leaving options and files out', () => {
    const argv = ['/opt/Kestrel/kestrel', '--no-sandbox', '/work/repo', '/work/notes.txt', '/work/other'];
    assert.deepEqual(foldersInArgs(argv, '/home/someone', isDir), ['/work/repo', '/work/other']);
  });

  test('a folder that is not a whole path is taken from the folder the launch was made in', () => {
    assert.deepEqual(foldersInArgs(['/opt/Kestrel/kestrel', 'repo'], '/work', isDir), ['/work/repo']);
  });

  test('the program itself is never a folder to open', () => {
    assert.deepEqual(foldersInArgs(['/work/repo'], '/work', isDir), []);
  });
});
