import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'release-needed.sh');
const version = JSON.parse(readFileSync(join(here, '..', '..', 'app', 'package.json'), 'utf8')).version;
const [major, minor, patch] = version.split('.').map(Number);
const dir = mkdtempSync(join(tmpdir(), 'kestrel-feed-'));

/** Asks the script about a feed file that says `published` (null: there is no feed). */
function ask(published) {
  const feed = join(dir, `${published ?? 'none'}.yml`);
  if (published !== null) writeFileSync(feed, `version: ${published}\nfiles:\n  - url: x\n`);
  const run = spawnSync('bash', [script, '--feed', feed], { encoding: 'utf8' });
  return { code: run.status, said: run.stdout + run.stderr };
}

test('a feed that serves an older version: a release is due', () => {
  const older = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.99`;
  const { code, said } = ask(older);
  assert.equal(code, 0);
  assert.match(said, new RegExp(`a release of ${version.replaceAll('.', '\\.')} is due`));
});

test('no feed at all is the first release', () => {
  assert.equal(ask(null).code, 0);
});

test('a feed that already serves this version, or a later one: not due, and says why', () => {
  const same = ask(version);
  assert.equal(same.code, 1);
  assert.match(same.said, /no release due \(bump the version to cut one\)/);
  assert.equal(ask(`${major}.${minor + 1}.0`).code, 1);
});

test('versions are compared as numbers, not as text', () => {
  // 0.0.9 is older than 0.0.23, though "9" sorts after "2".
  assert.equal(ask(`${major}.${minor}.${patch + 1}`).code, 1);
  if (patch >= 10) assert.equal(ask(`${major}.${minor}.9`).code, 0);
});

test('an option it does not know is "cannot tell", never "not due"', () => {
  assert.equal(spawnSync('bash', [script, '--nope'], { encoding: 'utf8' }).status, 2);
});
