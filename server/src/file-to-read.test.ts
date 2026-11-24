// What the user may open to read in a tab (file-to-read.ts): a Markdown or PDF file wherever it is on this
// computer, said in words a person can act on when it cannot be shown; and where it is, for the tab. The
// agent's side (`send_file`) stays confined: display.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileToRead, linkedPath, placeOf } from './file-to-read.ts';
import { VIEWABLE_MAX_BYTES } from './shared/viewable-files.ts';

function disk() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-read-')));
  const own = join(root, 'worktrees', 'mine');
  const theirs = join(root, 'worktrees', 'terraform-49c5ed04', 'modules', 'code-graph');
  const elsewhere = join(root, 'elsewhere');
  for (const dir of [own, theirs, elsewhere]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(own, 'plan.md'), '# Plan');
  writeFileSync(join(theirs, 'README.md'), '# Code graph');
  writeFileSync(join(elsewhere, 'report.pdf'), '%PDF-1.7');
  return { root, own, theirs, elsewhere };
}

describe('a file the user opens to read', () => {
  it('opens in the session’s own folder, by a relative path', () => {
    const d = disk();
    expect(fileToRead('plan.md', d.own)).toEqual({ path: join(d.own, 'plan.md'), type: 'text/markdown; charset=utf-8' });
  });

  it('opens in another session’s worktree, and anywhere else on this computer', () => {
    const d = disk();
    expect(fileToRead(join(d.theirs, 'README.md'), d.own).path).toBe(join(d.theirs, 'README.md'));
    expect(fileToRead(join(d.elsewhere, 'report.pdf'), d.own)).toEqual({ path: join(d.elsewhere, 'report.pdf'), type: 'application/pdf' });
    expect(fileToRead(join(d.elsewhere, 'report.pdf'), null).path).toBe(join(d.elsewhere, 'report.pdf'));
  });

  it('reads ~/ as the home folder', () => {
    expect(linkedPath('~/notes/a.md', '/somewhere')).toBe(join(homedir(), 'notes', 'a.md'));
  });

  it('lets the real file decide its type: a link named .md cannot hand over something else', () => {
    const d = disk();
    writeFileSync(join(d.elsewhere, 'keys.txt'), 'secret');
    symlinkSync(join(d.elsewhere, 'keys.txt'), join(d.elsewhere, 'innocent.md'));
    expect(() => fileToRead(join(d.elsewhere, 'innocent.md'), d.own)).toThrow(/Markdown and PDF files/);
    symlinkSync(join(d.theirs, 'README.md'), join(d.elsewhere, 'link.md'));
    expect(fileToRead(join(d.elsewhere, 'link.md'), d.own).path).toBe(join(d.theirs, 'README.md'));
  });

  it('says why not, to the person who clicked: no such file, not Markdown or PDF, a folder, too large', () => {
    const d = disk();
    expect(() => fileToRead(join(d.elsewhere, 'gone.md'), d.own)).toThrow(`There is no file at ${join(d.elsewhere, 'gone.md')}. It may have been moved or deleted.`);
    expect(() => fileToRead(join(d.elsewhere, 'notes.txt'), d.own)).toThrow('Kestrel shows Markdown and PDF files here. Open this one in another app.');
    mkdirSync(join(d.elsewhere, 'docs.md'));
    expect(() => fileToRead(join(d.elsewhere, 'docs.md'), d.own)).toThrow(/is a folder, not a file/);
    writeFileSync(join(d.elsewhere, 'huge.md'), Buffer.alloc(VIEWABLE_MAX_BYTES.markdown + 1, 'x'));
    expect(() => fileToRead(join(d.elsewhere, 'huge.md'), d.own)).toThrow(/larger than 2 MB/);
    expect(() => fileToRead('plan.md', null)).toThrow(/relative to the session’s folder/);
    for (const given of [join(d.elsewhere, 'gone.md'), join(d.elsewhere, 'notes.txt')]) {
      expect(() => fileToRead(given, d.own)).not.toThrow(/working folder|send_file|outside this session/);
    }
  });
});

describe('where an opened file is, for its tab', () => {
  it('in the session’s folder, in another session’s worktree (named), or elsewhere', () => {
    const d = disk();
    const worktrees = [
      { id: 'me', title: 'Mine', path: d.own },
      { id: 'tf', title: 'Terraform modules', path: join(d.root, 'worktrees', 'terraform-49c5ed04') },
      { id: 'plain', title: 'No worktree', path: null },
    ];
    expect(placeOf(join(d.own, 'plan.md'), 'me', d.own, worktrees)).toEqual({ path: join(d.own, 'plan.md'), inSessionFolder: true });
    expect(placeOf(join(d.theirs, 'README.md'), 'me', d.own, worktrees)).toEqual({ path: join(d.theirs, 'README.md'), inSessionFolder: false, otherSession: { id: 'tf', title: 'Terraform modules' } });
    expect(placeOf(join(d.elsewhere, 'report.pdf'), 'me', d.own, worktrees)).toEqual({ path: join(d.elsewhere, 'report.pdf'), inSessionFolder: false });
  });
});
