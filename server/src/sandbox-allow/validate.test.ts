// What may go on the always-allowed list, and the reason for each refusal.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Refused } from '../refused.ts';
import { commandEntry, commandEntryFromText, folderEntry, type FolderContext } from './validate.ts';

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-allow-')));
  const home = join(root, 'home');
  const dirs = ['home/.gnupg', 'home/code/shop', 'home/code/other', 'data/worktrees/a', 'elsewhere'];
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  symlinkSync(join(home, '.gnupg'), join(root, 'gnupg-link'));
  const context: FolderContext = { home, dataDir: join(root, 'data'), projectFolders: [join(home, 'code/shop')], worktrees: [join(root, 'data/worktrees/a')] };
  return { root, home, context };
}

describe('a command entry', () => {
  it('is a program and up to two subcommand words', () => {
    expect(commandEntryFromText('  git   commit ')).toEqual({ kind: 'command', words: ['git', 'commit'] });
    expect(commandEntryFromText('gpg')).toEqual({ kind: 'command', words: ['gpg'] });
    expect(commandEntry(['docker', 'compose', 'up'])).toEqual({ kind: 'command', words: ['docker', 'compose', 'up'] });
  });

  it.each([
    ['', /Enter a command/],
    ['/usr/bin/git commit', /not a program name/],
    ['FOO=1 git', /not a program name/],
    ['git commit --amend', /not a subcommand word/],
    ['git commit *', /not a subcommand word/],
    ['git commit; rm', /not a subcommand word/],
    ['a b c d', /at most 2 subcommand words/],
    ['git', /Name the git subcommand/],
    ['sudo', /runs other programs/],
    ['bash', /runs other programs/],
    ['env', /runs other programs/],
    ['xargs git', /runs other programs/],
    ['python3', /runs other programs/],
  ])('refuses %j with a reason', (text, reason) => {
    expect(() => commandEntryFromText(text)).toThrow(Refused);
    expect(() => commandEntryFromText(text)).toThrow(reason);
  });
});

describe('a folder entry', () => {
  it('is resolved from ~ and symlinks to the real folder, with its access', () => {
    const m = machine();
    expect(folderEntry('~/.gnupg', 'read-write', m.context)).toEqual({ kind: 'folder', path: join(m.home, '.gnupg'), access: 'read-write' });
    expect(folderEntry(join(m.root, 'gnupg-link'), 'read', m.context)).toEqual({ kind: 'folder', path: join(m.home, '.gnupg'), access: 'read' });
    expect(folderEntry(join(m.root, 'elsewhere'), 'read', m.context)).toMatchObject({ path: join(m.root, 'elsewhere') });
  });

  it.each([
    ['/', 'read', /whole disk/],
    ['~', 'read', /home folder or holds it/],
    ['HOME_PARENT', 'read', /home folder or holds it/],
    ['~/code/shop', 'read-write', /registered project folder/],
    ['~/code/shop/src-not-there', 'read', /no folder/],
    ['~/code', 'read', /registered project folder/],
    ['DATA/worktrees/a', 'read-write', /Kestrel's own data folder/],
    ['DATA', 'read', /Kestrel's own data folder/],
    ['relative/path', 'read', /not a full path/],
    ['', 'read', /Enter a folder/],
    ['~/.gnupg', 'write', /only read the folder or also write/],
  ])('refuses %j (%s) with a reason', (given, access, reason) => {
    const m = machine();
    const path = given.replace('HOME_PARENT', m.root).replace('DATA', m.context.dataDir);
    expect(() => folderEntry(path, access, m.context)).toThrow(reason);
  });

  it('refuses a session worktree that is not under the data folder', () => {
    const m = machine();
    const context = { ...m.context, worktrees: [join(m.root, 'elsewhere')] };
    expect(() => folderEntry(join(m.root, 'elsewhere'), 'read', context)).toThrow(/session worktree/);
  });
});
