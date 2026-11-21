import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { confinementDenial, writeOutside } from './confine.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-confine-')));
const work = join(base, 'work');
const project = join(base, 'project');
const secret = join(base, 'secret');
for (const d of [work, project, secret]) mkdirSync(d);
writeFileSync(join(secret, 'key.txt'), 'x');
symlinkSync(secret, join(work, 'escape'));

describe('editing session', () => {
  const c = { directory: work, readOnly: false, readable: [project] };
  it('is not confined: where it writes follows its permission mode', () => {
    expect(confinementDenial('Write', { file_path: join(project, 'x') }, c)).toBeNull();
    expect(confinementDenial('Edit', { file_path: '../secret/x' }, c)).toBeNull();
    expect(confinementDenial('Read', { file_path: join(secret, 'key.txt') }, c)).toBeNull();
    expect(confinementDenial('Bash', { command: 'ls' }, c)).toBeNull();
  });
});

describe('an edit outside the session folder', () => {
  it('is nothing for a path inside, new files and relative paths included', () => {
    expect(writeOutside('Write', { file_path: join(work, 'a/b/new.txt') }, work)).toBeNull();
    expect(writeOutside('Edit', { file_path: 'src/x.ts' }, work)).toBeNull();
  });
  it('is the resolved target outside, through .. and through a symlink', () => {
    expect(writeOutside('Write', { file_path: join(project, 'x') }, work)).toBe(join(project, 'x'));
    expect(writeOutside('Edit', { file_path: '../project/x' }, work)).toBe(join(project, 'x'));
    expect(writeOutside('MultiEdit', { file_path: join(work, 'escape', 'key.txt') }, work)).toBe(join(secret, 'key.txt'));
    expect(writeOutside('NotebookEdit', { notebook_path: join(secret, 'n.ipynb') }, work)).toBe(join(secret, 'n.ipynb'));
  });
  it('only concerns the file-editing tools', () => {
    expect(writeOutside('Read', { file_path: join(secret, 'key.txt') }, work)).toBeNull();
    expect(writeOutside('Bash', { command: 'touch /x' }, work)).toBeNull();
  });
});

describe('read-only session', () => {
  const c = { directory: work, readOnly: true, readable: [project] };
  it('reads the registered projects and its scratch folder', () => {
    expect(confinementDenial('Read', { file_path: join(project, 'a.ts') }, c)).toBeNull();
    expect(confinementDenial('Grep', { pattern: 'x', path: project }, c)).toBeNull();
    expect(confinementDenial('Grep', { pattern: 'x' }, c)).toBeNull();
    expect(confinementDenial('Glob', { pattern: join(project, '**/*.ts') }, c)).toBeNull();
  });
  it('refuses anything else on disk, including via symlink', () => {
    expect(confinementDenial('Read', { file_path: join(secret, 'key.txt') }, c)).toMatch(/read-only/);
    expect(confinementDenial('Read', { file_path: join(work, 'escape', 'key.txt') }, c)).toMatch(/read-only/);
    expect(confinementDenial('Grep', { pattern: 'x', path: base }, c)).toMatch(/read-only/);
    expect(confinementDenial('Glob', { pattern: join(secret, '*.txt') }, c)).toMatch(/read-only/);
    expect(confinementDenial('Read', { file_path: '/etc/hosts' }, c)).toMatch(/read-only/);
  });
});

describe('the session’s attachments folder', () => {
  const attachments = join(base, 'attachments', 'sessions', 's1');
  const other = join(base, 'attachments', 'sessions', 's2');
  mkdirSync(join(attachments, 'a1'), { recursive: true });
  mkdirSync(join(other, 'b1'), { recursive: true });
  writeFileSync(join(attachments, 'a1', 'notes.txt'), 'n');
  writeFileSync(join(other, 'b1', 'theirs.txt'), 't');
  it('a read-only session may read its own attachments and nothing wider', () => {
    const c = { directory: work, readOnly: true, readable: [attachments] };
    expect(confinementDenial('Read', { file_path: join(attachments, 'a1', 'notes.txt') }, c)).toBeNull();
    expect(confinementDenial('Read', { file_path: join(other, 'b1', 'theirs.txt') }, c)).toMatch(/read-only/);
    expect(confinementDenial('Glob', { pattern: join(base, 'attachments', '**', '*.txt') }, c)).toMatch(/read-only/);
  });
  it('an editing session writing there is outside its folder, so its mode decides', () => {
    expect(writeOutside('Write', { file_path: join(attachments, 'a1', 'notes.txt') }, work)).toBe(join(attachments, 'a1', 'notes.txt'));
  });
});
