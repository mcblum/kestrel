import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { feedFiles } from './feed-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the Mac feed lists the update zip first, then the DMG', () => {
  assert.deepEqual(feedFiles('mac', 'arm64', '0.0.23'), {
    feed: 'latest-mac.yml',
    feeds: ['latest-mac.yml', 'beta-mac.yml'],
    files: ['Kestrel-0.0.23-arm64-mac.zip', 'Kestrel-0.0.23-arm64.dmg'],
    blockmaps: ['Kestrel-0.0.23-arm64-mac.zip.blockmap'],
  });
});

test('a beta’s feed is the beta feed alone, and its files carry the beta version', () => {
  assert.deepEqual(feedFiles('mac', 'arm64', '0.0.32-beta.1'), {
    feed: 'beta-mac.yml',
    feeds: ['beta-mac.yml'],
    files: ['Kestrel-0.0.32-beta.1-arm64-mac.zip', 'Kestrel-0.0.32-beta.1-arm64.dmg'],
    blockmaps: ['Kestrel-0.0.32-beta.1-arm64-mac.zip.blockmap'],
  });
  assert.deepEqual(feedFiles('win', 'x64', '0.0.32-beta.1').feeds, ['beta.yml']);
  assert.deepEqual(feedFiles('linux', 'x64', '0.0.32-beta.1').feeds, ['beta-linux.yml']);
});

test('the Windows feed is latest.yml and names the installer', () => {
  assert.deepEqual(feedFiles('win', 'x64', '0.0.23'), { feed: 'latest.yml', feeds: ['latest.yml', 'beta.yml'], files: ['Kestrel-Setup-0.0.23-x64.exe'], blockmaps: ['Kestrel-Setup-0.0.23-x64.exe.blockmap'] });
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

/** Runs write-feed.mjs on a folder of stand-in Mac artifacts for `version`; returns the folder. */
function writeFeeds(version, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-release-'));
  for (const name of feedFiles('mac', 'arm64', version).files) writeFileSync(join(dir, name), `bytes of ${name}`);
  const run = spawnSync(process.execPath, [join(here, 'write-feed.mjs'), '--dir', dir, '--version', version, ...extra], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return dir;
}

test('a release build writes latest-mac.yml and the same feed as beta-mac.yml', () => {
  const dir = writeFeeds('0.0.32');
  const latest = readFileSync(join(dir, 'latest-mac.yml'), 'utf8');
  assert.match(latest, /^version: 0\.0\.32$/m);
  assert.match(latest, /^path: Kestrel-0\.0\.32-arm64-mac\.zip$/m);
  assert.equal(readFileSync(join(dir, 'beta-mac.yml'), 'utf8'), latest);
});

test('a beta build writes beta-mac.yml only', () => {
  const dir = writeFeeds('0.0.32-beta.1');
  assert.equal(existsSync(join(dir, 'latest-mac.yml')), false);
  const beta = readFileSync(join(dir, 'beta-mac.yml'), 'utf8');
  assert.match(beta, /^version: 0\.0\.32-beta\.1$/m);
  assert.match(beta, /^ {2}- url: Kestrel-0\.0\.32-beta\.1-arm64-mac\.zip$/m);
});

test('publishing writes one feed at a time, with absolute URLs', () => {
  const dir = writeFeeds('0.0.32-beta.1', ['--base', 'https://example.test/pkg/', '--out', join(tmpdir(), `feed-${process.pid}.yml`)]);
  assert.equal(existsSync(join(dir, 'beta-mac.yml')), false);
  assert.match(readFileSync(join(tmpdir(), `feed-${process.pid}.yml`), 'utf8'), /^path: https:\/\/example\.test\/pkg\/Kestrel-0\.0\.32-beta\.1-arm64-mac\.zip$/m);
});

test('a version that is not 1.2.3 or 1.2.3-beta.4 writes no feed', () => {
  const run = spawnSync(process.execPath, [join(here, 'write-feed.mjs'), '--dir', tmpdir(), '--version', '0.0.32-rc.1'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /not a Kestrel version/);
});

test('version.mjs gives the shell scripts the same rule', () => {
  const cli = (...args) => spawnSync(process.execPath, [join(here, 'version.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(cli('channel', '0.0.32-beta.1').stdout.trim(), 'beta');
  assert.equal(cli('feed', '0.0.32-beta.1').stdout.trim(), 'beta-mac.yml');
  assert.equal(cli('feeds', '0.0.32', '').stdout.trim(), 'latest-mac.yml\nbeta-mac.yml');
  assert.equal(cli('feeds', '0.0.32', '0.0.33-beta.1').stdout.trim(), 'latest-mac.yml');
  assert.equal(cli('newer', '0.0.32', '0.0.32-beta.9').status, 0);
  assert.equal(cli('newer', '0.0.32-beta.9', '0.0.32').status, 1);
  assert.equal(cli('channel', '1.2').status, 2);
});
