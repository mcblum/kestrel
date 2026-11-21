import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFolderQueue, foldersOnly } from './open-folders.mjs';

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
