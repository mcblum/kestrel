import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'release-needed.sh');
const root = mkdtempSync(join(tmpdir(), 'kestrel-feeds-'));
let n = 0;

/** Asks the script about `version` against a folder of feeds serving `stable` and `beta` (null: no such feed). */
function ask(version, { stable = null, beta = null } = {}) {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  if (stable !== null) writeFileSync(join(dir, 'latest-mac.yml'), `version: ${stable}\nfiles:\n  - url: x\n`);
  if (beta !== null) writeFileSync(join(dir, 'beta-mac.yml'), `version: ${beta}\nfiles:\n  - url: x\n`);
  const run = spawnSync('bash', [script, '--feeds', dir, '--version', version], { encoding: 'utf8' });
  return { code: run.status, said: run.stdout + run.stderr };
}

test('a release newer than the stable feed is due', () => {
  const { code, said } = ask('0.0.32', { stable: '0.0.31', beta: '0.0.31' });
  assert.equal(code, 0);
  assert.match(said, /a release of 0\.0\.32 is due/);
});

test('no feed at all is the first release', () => {
  assert.equal(ask('0.0.32').code, 0);
});

test('a feed that already serves this version, or a later one: not due, and says why', () => {
  const same = ask('0.0.31', { stable: '0.0.31' });
  assert.equal(same.code, 1);
  assert.match(same.said, /no release due \(bump the version to cut one\)/);
  assert.equal(ask('0.0.31', { stable: '0.1.0' }).code, 1);
});

test('versions are compared as numbers, not as text', () => {
  // 0.0.9 is older than 0.0.23, though "9" sorts after "2".
  assert.equal(ask('0.0.23', { stable: '0.0.9' }).code, 0);
  assert.equal(ask('0.0.9', { stable: '0.0.23' }).code, 1);
});

test('a release is compared with the stable feed only: a newer beta of it does not hold it up', () => {
  assert.equal(ask('0.0.32', { stable: '0.0.31', beta: '0.0.32-beta.3' }).code, 0);
});

test('a beta is due when newer than both feeds, and the first beta needs no beta feed', () => {
  const first = ask('0.0.32-beta.1', { stable: '0.0.31' });
  assert.equal(first.code, 0);
  assert.match(first.said, /a beta of 0\.0\.32-beta\.1 is due/);
  assert.equal(ask('0.0.32-beta.2', { stable: '0.0.31', beta: '0.0.32-beta.1' }).code, 0);
  assert.equal(ask('0.0.32-beta.10', { stable: '0.0.31', beta: '0.0.32-beta.9' }).code, 0);
});

test('a beta already out, or one for a version already released, is not due', () => {
  assert.equal(ask('0.0.32-beta.1', { stable: '0.0.31', beta: '0.0.32-beta.1' }).code, 1);
  assert.equal(ask('0.0.32-beta.1', { stable: '0.0.31', beta: '0.0.32-beta.2' }).code, 1);
  // 0.0.32 is out: its betas are older than it, even when the beta feed was never written.
  assert.equal(ask('0.0.32-beta.4', { stable: '0.0.32' }).code, 1);
});

test('a version that is neither 1.2.3 nor 1.2.3-beta.4 is "cannot tell", never "not due"', () => {
  const rc = ask('0.0.32-rc.1', { stable: '0.0.31' });
  assert.equal(rc.code, 2);
  assert.match(rc.said, /1\.2\.3-beta\.4 for a beta/);
});

test('an option it does not know is "cannot tell", never "not due"', () => {
  assert.equal(spawnSync('bash', [script, '--nope'], { encoding: 'utf8' }).status, 2);
});
