import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createFolderChooser, readRemembered, rememberFor, startDirectory } from './folder-chooser.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'kestrel-folder-chooser-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('startDirectory', () => {
  test('opens in the remembered folder when it still exists', () => {
    assert.equal(startDirectory('/Users/me/Code', { exists: () => true, home: '/Users/me' }), '/Users/me/Code');
  });
  test('falls back to home when the remembered folder is gone', () => {
    assert.equal(startDirectory('/Users/me/Gone', { exists: () => false, home: '/Users/me' }), '/Users/me');
  });
  test('falls back to home when nothing is remembered', () => {
    assert.equal(startDirectory(null, { exists: () => true, home: '/Users/me' }), '/Users/me');
  });
});

test('remembers the folder the chosen one is in', () => {
  assert.equal(rememberFor('/Users/me/Code/website'), '/Users/me/Code');
});

describe('createFolderChooser', () => {
  const chooser = (file, answers, calls, exists = () => true) =>
    createFolderChooser({
      file,
      home: '/Users/me',
      exists,
      showOpenDialog: async (options) => {
        calls.push(options);
        return answers.shift();
      },
    });

  test('first use opens at home, the next at the parent of the last pick', async () => {
    const file = join(scratch, 'a', 'folder-chooser.json');
    const calls = [];
    const pick = chooser(file, [{ canceled: false, filePaths: ['/Users/me/Code/website'] }, { canceled: false, filePaths: ['/Users/me/Code/api'] }], calls);
    assert.equal(await pick({ title: 'Choose a folder' }), '/Users/me/Code/website');
    assert.equal(await pick(), '/Users/me/Code/api');
    assert.equal(calls[0].defaultPath, '/Users/me');
    assert.equal(calls[0].title, 'Choose a folder');
    assert.deepEqual(calls[0].properties, ['openDirectory', 'createDirectory']);
    assert.equal(calls[1].defaultPath, '/Users/me/Code');
  });

  test('survives a restart: a new chooser on the same file opens where the last left off', async () => {
    const file = join(scratch, 'b', 'folder-chooser.json');
    await chooser(file, [{ canceled: false, filePaths: ['/Volumes/Work/client/site'] }], [])();
    assert.equal(readRemembered(file), '/Volumes/Work/client');
    const calls = [];
    await chooser(file, [{ canceled: true, filePaths: [] }], calls)();
    assert.equal(calls[0].defaultPath, '/Volumes/Work/client');
  });

  test('cancel answers null and keeps what was remembered', async () => {
    const file = join(scratch, 'c', 'folder-chooser.json');
    const pick = chooser(file, [{ canceled: false, filePaths: ['/Users/me/Code/x'] }, { canceled: true, filePaths: [] }], []);
    await pick();
    assert.equal(await pick(), null);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { lastParent: '/Users/me/Code' });
  });

  test('a remembered folder that no longer exists opens at home', async () => {
    const file = join(scratch, 'd', 'folder-chooser.json');
    await chooser(file, [{ canceled: false, filePaths: ['/Users/me/Old/x'] }], [])();
    const calls = [];
    await chooser(file, [{ canceled: true, filePaths: [] }], calls, () => false)();
    assert.equal(calls[0].defaultPath, '/Users/me');
  });

  test('an unreadable state file is the same as none', () => {
    assert.equal(readRemembered(join(scratch, 'missing.json')), null);
  });
});
