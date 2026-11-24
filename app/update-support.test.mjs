import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMissingFeed, updateSupport } from './update-support.mjs';

test('a checkout never updates, and says so', () => {
  assert.deepEqual(updateSupport({ platform: 'darwin', packaged: false, env: {} }), { enabled: false, reason: 'A build run from a checkout does not update itself.' });
});

test('an installed copy updates on macOS and Windows', () => {
  assert.deepEqual(updateSupport({ platform: 'darwin', packaged: true, env: {} }), { enabled: true });
  assert.deepEqual(updateSupport({ platform: 'win32', packaged: true, env: {} }), { enabled: true });
});

test('KESTREL_UPDATES=off turns updates off with that reason', () => {
  assert.deepEqual(updateSupport({ platform: 'win32', packaged: true, env: { KESTREL_UPDATES: 'off' } }), { enabled: false, reason: 'KESTREL_UPDATES is set to off.' });
});

test('on Linux only a copy started from an AppImage updates', () => {
  assert.deepEqual(updateSupport({ platform: 'linux', packaged: true, env: { APPIMAGE: '/opt/Kestrel.AppImage' } }), { enabled: true });
  const unpacked = updateSupport({ platform: 'linux', packaged: true, env: {} });
  assert.equal(unpacked.enabled, false);
  assert.match(unpacked.reason, /only the AppImage updates itself/);
});

test('a feed that is not there yet is told from a real failure, for every platform’s feed', () => {
  assert.equal(isMissingFeed(new Error('Cannot find latest-mac.yml in the latest release artifacts')), true);
  assert.equal(isMissingFeed(new Error('Cannot find latest.yml in the latest release artifacts')), true);
  assert.equal(isMissingFeed(new Error('Cannot find latest-linux-arm64.yml in the latest release artifacts')), true);
  assert.equal(isMissingFeed(new Error('HttpError: 404 Not Found')), true);
  assert.equal(isMissingFeed(new Error('Cannot find channel "beta-mac.yml" update info: HttpError')), true);
  assert.equal(isMissingFeed(Object.assign(new Error('x'), { message: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })), true);
  assert.equal(isMissingFeed(new Error('net::ERR_INTERNET_DISCONNECTED')), false);
});
