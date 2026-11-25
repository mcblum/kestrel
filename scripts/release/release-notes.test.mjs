import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'release-notes.mjs');

/** Runs the script against a folder holding `files`. */
function run(command, version, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-notes-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const out = spawnSync(process.execPath, [script, command, version, '--dir', dir], { encoding: 'utf8' });
  return { code: out.status, out: out.stdout, err: out.stderr };
}

const NOTES = '# Kestrel 0.0.32\n\n## Kestrel on your iPhone\n\nSessions on a phone.\n\n![The phone](images/phone.png)\n';

test('a release without notes fails early, saying which file to write', () => {
  const { code, err } = run('check', '0.0.32');
  assert.equal(code, 1);
  assert.match(err, /Kestrel 0\.0\.32 has no release notes: write whats-new\/0\.0\.32\.md/);
});

test('a release with notes passes and names them', () => {
  const { code, out } = run('check', '0.0.32', { '0.0.32.md': NOTES });
  assert.equal(code, 0);
  assert.match(out, /whats-new\/0\.0\.32\.md: “Kestrel 0\.0\.32”/);
});

test('a notes file without a title line is refused with the reason', () => {
  const { code, err } = run('check', '0.0.32', { '0.0.32.md': 'Kestrel 0.0.32\n\ntext\n' });
  assert.equal(code, 1);
  assert.match(err, /first line must be the title/);
});

test('a beta without notes publishes as before; with them it reads its release\'s file', () => {
  assert.equal(run('check', '0.0.33-beta.1').code, 0);
  const { code, out } = run('check', '0.0.32-beta.7', { '0.0.32.md': NOTES });
  assert.equal(code, 0);
  assert.match(out, /0\.0\.32\.md/);
});

test('the host gets the notes under the title, pictures left out', () => {
  const { code, out } = run('body', '0.0.32', { '0.0.32.md': NOTES });
  assert.equal(code, 0);
  assert.equal(out, '## Kestrel on your iPhone\n\nSessions on a phone.\n');
});

test('a version that cannot be released is refused', () => {
  assert.equal(run('check', '0.0.32-rc.1').code, 1);
});

test('the host gets no links into the app: a link-only line goes, a link in a sentence becomes its words', () => {
  const notes = '# Kestrel 0.0.32\n\nChoose in [Settings → Git](#/settings/git).\n\n[Open Settings → Git](#/settings/git)\n\nMore.\n';
  const { code, out } = run('body', '0.0.32', { '0.0.32.md': notes });
  assert.equal(code, 0);
  assert.equal(out, 'Choose in Settings → Git.\n\nMore.\n');
});
