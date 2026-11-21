import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OutsideFolder, listDirectory, readFileContent } from './files.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-files-')));
const root = join(base, 'work');
const secret = join(base, 'secret');
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, '.git'));
mkdirSync(secret);
writeFileSync(join(root, 'README.md'), '# hello');
writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
writeFileSync(join(root, 'image.bin'), Buffer.from([1, 0, 2, 0]));
writeFileSync(join(secret, 'key.txt'), 'x');
symlinkSync(secret, join(root, 'escape'));

describe('listing a session folder', () => {
  it('lists folders first, then files, and leaves out .git', () => {
    expect(listDirectory(root, '').map((e) => `${e.dir ? 'd' : 'f'} ${e.path}`)).toEqual(['d src', 'f escape', 'f image.bin', 'f README.md']);
  });
  it('lists a subfolder with paths from the root', () => {
    expect(listDirectory(root, 'src')).toEqual([{ name: 'a.ts', path: 'src/a.ts', dir: false }]);
  });
  it('refuses a path that leaves the folder, by .. or through a symlink', () => {
    expect(() => listDirectory(root, '../secret')).toThrow(OutsideFolder);
    expect(() => listDirectory(root, 'escape')).toThrow(OutsideFolder);
    expect(() => readFileContent(root, 'escape/key.txt')).toThrow(OutsideFolder);
    expect(() => readFileContent(root, '/etc/hosts')).toThrow(OutsideFolder);
  });
});

describe('reading a file', () => {
  it('returns text', () => {
    expect(readFileContent(root, 'src/a.ts')).toEqual({ kind: 'text', text: 'export const a = 1;', truncated: false });
  });
  it('only describes a binary file, and refuses a folder or a missing file', () => {
    expect(readFileContent(root, 'image.bin')).toEqual({ kind: 'binary' });
    expect(() => readFileContent(root, 'src')).toThrow(OutsideFolder);
    expect(() => readFileContent(root, 'nope.txt')).toThrow(OutsideFolder);
  });
});
