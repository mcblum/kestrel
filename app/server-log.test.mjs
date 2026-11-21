import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openServerLog } from './server-log.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'kestrel-log-'));
const now = () => new Date('2026-11-16T12:00:00Z');

test('appends what the server prints under a start line', () => {
  const dir = scratch();
  const write = openServerLog(dir, { now });
  write('[kestrel] one\n');
  write('[kestrel] two\n');
  assert.equal(readFileSync(join(dir, 'server.log'), 'utf8'), '\n---- Kestrel started 2026-11-16T12:00:00.000Z ----\n[kestrel] one\n[kestrel] two\n');
});

test('keeps earlier launches in the same file until it is too big, then keeps one old file', () => {
  const dir = scratch();
  openServerLog(dir, { now })('first\n');
  openServerLog(dir, { now })('second\n');
  assert.match(readFileSync(join(dir, 'server.log'), 'utf8'), /first\n[\s\S]*second\n/);
  writeFileSync(join(dir, 'server.log'), 'x'.repeat(50));
  openServerLog(dir, { now, maxBytes: 10 })('third\n');
  assert.equal(readFileSync(join(dir, 'server.log.1'), 'utf8'), 'x'.repeat(50));
  assert.doesNotMatch(readFileSync(join(dir, 'server.log'), 'utf8'), /x/);
});

test('a folder that cannot be written does not throw', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'blocked'), '');
  const write = openServerLog(join(dir, 'blocked', 'logs'), { now });
  assert.doesNotThrow(() => write('anything'));
});
