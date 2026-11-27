import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { nodeLogFile, openNodeLog } from './log-file.ts';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'kn-log-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the node’s own log file', () => {
  test('is in its data folder, readable by the user only, in a folder that is theirs alone', () => {
    const file = nodeLogFile(dir);
    const append = openNodeLog(file, 1024, () => new Date('2026-11-27T10:00:00Z'))!;
    append('[kestrel] server on http://127.0.0.1:4318\n');
    expect(file).toBe(join(dir, 'logs', 'node.log'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toBe('\n---- Kestrel worker node started 2026-11-27T10:00:00.000Z ----\n[kestrel] server on http://127.0.0.1:4318\n');
  });

  test('keeps one earlier file once the log passes its size at start', () => {
    const file = nodeLogFile(dir);
    openNodeLog(file, 10);
    writeFileSync(file, 'x'.repeat(20));
    openNodeLog(file, 10);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(20));
    expect(readFileSync(file, 'utf8')).toMatch(/^\n---- Kestrel worker node started/);
  });

  test('a log that cannot be written is no log, never a crash', () => {
    writeFileSync(join(dir, 'logs'), 'a file in the way');
    expect(openNodeLog(nodeLogFile(dir))).toBeNull();
  });
});
