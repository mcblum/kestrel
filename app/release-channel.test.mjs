import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { channelOf, compareVersions, feedFileName, feedsFor, feedToRead, isNewer, isVersion, newest, parseVersion, releaseDue, takesUpdate, versionInFeed, wantsBeta } from './release-channel.mjs';
import { channelFile, channelInfo, readSaved, saveChoice } from './update-channel.mjs';

test('a version is 1.2.3 (stable) or 1.2.3-beta.4 (beta), and nothing else', () => {
  assert.equal(channelOf('0.0.31'), 'stable');
  assert.equal(channelOf('0.0.32-beta.1'), 'beta');
  assert.deepEqual(parseVersion('1.20.3-beta.12'), { major: 1, minor: 20, patch: 3, beta: 12 });
  for (const bad of ['0.0', '0.0.32-rc.1', '0.0.32-beta', '0.0.32+build', '00.1.2', 'v0.0.32', '', null]) {
    assert.equal(isVersion(bad), false, String(bad));
    assert.throws(() => channelOf(bad), /is not a Kestrel version/);
  }
});

test('versions are ordered as semver orders them: a beta comes before its release', () => {
  const sorted = ['0.0.32', '0.0.9', '0.0.32-beta.10', '0.0.33-beta.1', '0.0.32-beta.2', '0.1.0', '0.0.31'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.0.9', '0.0.31', '0.0.32-beta.2', '0.0.32-beta.10', '0.0.32', '0.0.33-beta.1', '0.1.0']);
  assert.equal(compareVersions('0.0.32-beta.1', '0.0.32-beta.1'), 0);
  assert.equal(isNewer('0.0.32-beta.1', null), true);
  assert.equal(isNewer('0.0.32-beta.1', '0.0.32'), false);
  assert.equal(newest('0.0.31', null, '0.0.32-beta.1'), '0.0.32-beta.1');
  assert.equal(newest(null, null), null);
});

test('never a downgrade: a copy takes only a newer version, on either channel', () => {
  assert.equal(takesUpdate('0.0.31', '0.0.32-beta.1'), true);
  assert.equal(takesUpdate('0.0.32-beta.1', '0.0.32-beta.2'), true);
  assert.equal(takesUpdate('0.0.32-beta.3', '0.0.32'), true, 'the release its betas lead to');
  assert.equal(takesUpdate('0.0.32-beta.3', '0.0.31'), false, 'turning betas off keeps the beta');
  assert.equal(takesUpdate('0.0.32-beta.3', '0.0.32-beta.2'), false);
  assert.equal(takesUpdate('0.0.32', '0.0.32'), false);
  assert.equal(takesUpdate('0.0.32', 'garbage'), false);
});

test('feeds are named as electron-updater asks for them', () => {
  assert.equal(feedFileName('latest', 'mac', 'arm64'), 'latest-mac.yml');
  assert.equal(feedFileName('beta', 'mac', 'arm64'), 'beta-mac.yml');
  assert.equal(feedFileName('beta', 'win', 'x64'), 'beta.yml');
  assert.equal(feedFileName('beta', 'linux', 'x64'), 'beta-linux.yml');
  assert.equal(feedFileName('beta', 'linux', 'arm64'), 'beta-linux-arm64.yml');
});

test('a release is written to both feeds, a beta to the beta feed only', () => {
  assert.deepEqual(feedsFor('0.0.32'), ['latest', 'beta']);
  assert.deepEqual(feedsFor('0.0.32', { liveBeta: '0.0.32-beta.3' }), ['latest', 'beta']);
  assert.deepEqual(feedsFor('0.0.32-beta.1'), ['beta']);
  assert.deepEqual(feedsFor('0.0.32-beta.1', { liveBeta: '0.0.31' }), ['beta']);
});

test('a release leaves the beta feed alone when it already serves a newer beta', () => {
  assert.deepEqual(feedsFor('0.0.32', { liveBeta: '0.0.33-beta.1' }), ['latest']);
  assert.deepEqual(feedsFor('0.0.32', { liveBeta: 'not a version' }), ['latest', 'beta']);
});

test('a release is due against the stable feed, a beta against both', () => {
  assert.deepEqual(releaseDue('0.0.32', { stable: '0.0.31', beta: '0.0.32-beta.2' }), { due: true, against: '0.0.31', channel: 'stable' });
  assert.equal(releaseDue('0.0.32-beta.1', { stable: '0.0.31', beta: null }).due, true);
  assert.equal(releaseDue('0.0.32-beta.1', { stable: '0.0.32', beta: null }).due, false);
  assert.equal(releaseDue('0.0.32-beta.2', { stable: '0.0.31', beta: '0.0.32-beta.2' }).due, false);
});

test('which feed a copy reads: stable off the beta channel; on it, the beta feed unless missing or older', () => {
  assert.equal(feedToRead({ beta: false, stable: '0.0.31', betaFeed: '0.0.32-beta.1' }), 'latest');
  assert.equal(feedToRead({ beta: true, stable: '0.0.31', betaFeed: '0.0.32-beta.1' }), 'beta');
  assert.equal(feedToRead({ beta: true, stable: '0.0.32', betaFeed: '0.0.32' }), 'beta');
  assert.equal(feedToRead({ beta: true, stable: '0.0.33', betaFeed: '0.0.32-beta.3' }), 'latest', 'beta feed older');
  assert.equal(feedToRead({ beta: true, stable: '0.0.31', betaFeed: null }), 'latest', 'beta feed missing');
  assert.equal(feedToRead({ beta: true, stable: null, betaFeed: null }), 'beta', 'neither readable: the updater reports why');
});

test('the switch: on by default for a beta build, off for a release, and the choice wins once made', () => {
  assert.equal(wantsBeta('0.0.32-beta.1', null), true);
  assert.equal(wantsBeta('0.0.31', null), false);
  assert.equal(wantsBeta('0.0.32-beta.1', { beta: false }), false);
  assert.equal(wantsBeta('0.0.31', { beta: true }), true);
  assert.equal(wantsBeta('0.0.31', { beta: 'yes' }), false, 'a bad file is no choice');
});

test('the choice is kept in a file in the shell’s userData, read back as the channel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-channel-'));
  const file = channelFile(dir);
  assert.equal(readSaved(file), null);
  assert.deepEqual(channelInfo('0.0.32-beta.1', readSaved(file)), { beta: true, build: 'beta' });
  saveChoice(file, false);
  assert.deepEqual(channelInfo('0.0.32-beta.1', readSaved(file)), { beta: false, build: 'beta' });
  saveChoice(file, true);
  assert.deepEqual(channelInfo('0.0.31', readSaved(file)), { beta: true, build: 'stable' });
  writeFileSync(file, '{not json');
  assert.deepEqual(channelInfo('0.0.31', readSaved(file)), { beta: false, build: 'stable' });
  assert.throws(() => saveChoice(file, 'on'), /on or off/);
});

test('the version a feed serves is read from its version line', () => {
  assert.equal(versionInFeed("version: 0.0.32-beta.1\nfiles:\n  - url: x\n"), '0.0.32-beta.1');
  assert.equal(versionInFeed("files: []\nversion: '0.0.31'\n"), '0.0.31');
  assert.equal(versionInFeed('<html>sign in</html>'), null);
  assert.equal(versionInFeed(null), null);
});
