import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedFiles } from './feed-files.mjs';

test('the Mac feed lists the update zip first, then the DMG', () => {
  assert.deepEqual(feedFiles('mac', 'arm64', '0.0.23'), {
    feed: 'latest-mac.yml',
    files: ['Kestrel-0.0.23-arm64-mac.zip', 'Kestrel-0.0.23-arm64.dmg'],
    blockmaps: ['Kestrel-0.0.23-arm64-mac.zip.blockmap'],
  });
});

test('the Windows feed is latest.yml and names the installer', () => {
  assert.deepEqual(feedFiles('win', 'x64', '0.0.23'), { feed: 'latest.yml', files: ['Kestrel-Setup-0.0.23-x64.exe'], blockmaps: ['Kestrel-Setup-0.0.23-x64.exe.blockmap'] });
});

test('the Linux feed is named for the architecture the way electron-updater asks for it', () => {
  assert.equal(feedFiles('linux', 'x64', '0.0.23').feed, 'latest-linux.yml');
  assert.deepEqual(feedFiles('linux', 'x64', '0.0.23').files, ['Kestrel-0.0.23-x86_64.AppImage']);
  assert.equal(feedFiles('linux', 'arm64', '0.0.23').feed, 'latest-linux-arm64.yml');
  assert.deepEqual(feedFiles('linux', 'arm64', '0.0.23').files, ['Kestrel-0.0.23-arm64.AppImage']);
});

test('an unknown platform is refused', () => {
  assert.throws(() => feedFiles('bsd', 'x64', '0.0.23'), /no feed for bsd/);
});
