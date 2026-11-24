import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { makeRepo } from './test-repo.ts';
import { baseOf, changedFileCount, changedFiles, createWorktree, readChanges, repoRoot, splitDiff } from './git.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

describe('worktrees', () => {
  it('creates one on a new branch under the data directory and records the base', async () => {
    const repo = makeRepo();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
    const wt = await createWorktree(repo, join(data, 'worktrees'), '1234abcd-0000', 'Add a readme!', 'kestrel');
    expect(wt.path.startsWith(data)).toBe(true);
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
    expect(wt.branch).toBe('kestrel/add-a-readme-1234abcd');
    expect(await baseOf(wt.path, wt.branch)).toBe(wt.base);
    expect(await repoRoot(wt.path)).toBe(wt.path);
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: wt.path }).toString().trim()).toBe(wt.branch);
  });

  it('names the branch with the prefix it is given, or none', async () => {
    const repo = makeRepo();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
    const custom = await createWorktree(repo, join(data, 'worktrees'), 'dddddddd-1', 'Fix login', 'team/mcblum');
    const bare = await createWorktree(repo, join(data, 'worktrees'), 'eeeeeeee-1', 'Fix login', '');
    expect([custom.branch, bare.branch]).toEqual(['team/mcblum/fix-login-dddddddd', 'fix-login-eeeeeeee']);
    expect(await baseOf(bare.path, bare.branch)).toBe(bare.base);
    const listed = execFileSync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: repo }).toString().trim().split('\n');
    expect(listed).toEqual(expect.arrayContaining(['team/mcblum/fix-login-dddddddd', 'fix-login-eeeeeeee']));
  });

  it('keeps the base when a new branch is made inside the worktree, and records it under the new name', async () => {
    const repo = makeRepo();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
    const wt = await createWorktree(repo, join(data, 'worktrees'), 'ffffffff-1', 'Big change', 'kestrel');
    writeFileSync(join(wt.path, 'new.txt'), 'x\n');
    execFileSync('git', ['checkout', '-q', '-b', 'feature/JIRA-1'], { cwd: wt.path });
    execFileSync('git', ['add', '.'], { cwd: wt.path });
    execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: wt.path });
    expect(await baseOf(wt.path, 'feature/JIRA-1')).toBe(wt.base);
    expect(execFileSync('git', ['config', '--get', 'branch.feature/JIRA-1.kestrelbase'], { cwd: wt.path }).toString().trim()).toBe(wt.base);
    expect((await changedFiles(wt.path, wt.base)).map((f) => f.path)).toEqual(['new.txt']);
  });

  it('moves the base with a rebase, so work that landed on the base branch is not counted as the session\'s', async () => {
    const repo = makeRepo();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
    const main = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString().trim();
    const wt = await createWorktree(repo, join(data, 'worktrees'), 'abababab-1', 'Add a zone', 'kestrel');
    const commit = (cwd: string, file: string) => {
      writeFileSync(join(cwd, file), `${file}\n`);
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', file], { cwd });
    };
    commit(wt.path, 'mine.txt');
    for (const file of ['landed-1.txt', 'landed-2.txt', 'landed-3.txt']) commit(repo, file);
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    // Not rebased yet: the base is where the worktree was cut.
    expect(await baseOf(wt.path, wt.branch)).toBe(wt.base);
    execFileSync('git', ['rebase', '-q', main], { cwd: wt.path });
    expect(await baseOf(wt.path, wt.branch)).toBe(tip);
    expect(await changedFileCount(wt.path, tip)).toBe(1);
    expect((await changedFiles(wt.path, (await baseOf(wt.path, wt.branch))!)).map((f) => f.path)).toEqual(['mine.txt']);
  });

  it('moves the base when the rebase rewrote the commit the worktree was cut from', async () => {
    const repo = makeRepo();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
    const main = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString().trim();
    const commit = (cwd: string, file: string) => {
      writeFileSync(join(cwd, file), `${file}\n`);
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', file], { cwd });
    };
    // The checkout is on a branch with a commit of its own; the remote's default is the main line.
    execFileSync('git', ['checkout', '-q', '-b', 'earlier-work'], { cwd: repo });
    commit(repo, 'earlier.txt');
    const wt = await createWorktree(repo, join(data, 'worktrees'), 'cdcdcdcd-1', 'Add a zone', 'kestrel');
    commit(wt.path, 'mine.txt');
    execFileSync('git', ['checkout', '-q', main], { cwd: repo });
    for (const file of ['landed-1.txt', 'landed-2.txt']) commit(repo, file);
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    execFileSync('git', ['update-ref', `refs/remotes/origin/${main}`, tip], { cwd: repo });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${main}`], { cwd: repo });
    execFileSync('git', ['rebase', '-q', main], { cwd: wt.path });
    const base = await baseOf(wt.path, wt.branch);
    expect(base).toBe(tip);
    expect((await changedFiles(wt.path, base!)).map((f) => f.path).sort()).toEqual(['earlier.txt', 'mine.txt']);
  });

  it('keeps the recorded base once the branch has landed, so its change can still be seen', async () => {
    const repo = makeRepo();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
    const wt = await createWorktree(repo, join(data, 'worktrees'), 'efefefef-1', 'Add a zone', 'kestrel');
    writeFileSync(join(wt.path, 'mine.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: wt.path });
    execFileSync('git', ['commit', '-q', '-m', 'mine'], { cwd: wt.path });
    execFileSync('git', ['merge', '-q', '--ff-only', wt.branch], { cwd: repo });
    expect(await baseOf(wt.path, wt.branch)).toBe(wt.base);
  });

  it('falls back to where the worktree left the remote default branch, and to null when nothing is known', async () => {
    const repo = makeRepo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    expect(await baseOf(repo, 'no-such-record')).toBeNull();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'topic'], { cwd: repo });
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'b'], { cwd: repo });
    expect(await baseOf(repo, 'topic')).toBe(head);
  });

  it('refuses a repository with no commits, with a reason', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-empty-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await expect(createWorktree(dir, join(dir, '..', 'wt'), 'abcdef12', 'x', 'kestrel')).rejects.toThrow(/no commits/);
  });

  it('lists new, modified and deleted files with unified diffs', async () => {
    const repo = makeRepo();
    const data = mkdtempSync(join(tmpdir(), 'kestrel-data-'));
    const wt = await createWorktree(repo, join(data, 'w'), 'aaaaaaaa-1', 'change', 'kestrel');
    expect(await changedFiles(wt.path, wt.base)).toEqual([]);
    writeFileSync(join(wt.path, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(wt.path, 'new.txt'), 'hi\n');
    const files = await changedFiles(wt.path, wt.base);
    expect(files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'M'], ['new.txt', 'A']]);
    expect(files[1]!.diff).toContain('+hi');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('');
  });

  it('never touches the worktree index: it is byte-identical afterwards, and git still works', async () => {
    const repo = makeRepo();
    const data = mkdtempSync(join(tmpdir(), 'kestrel-data-'));
    const wt = await createWorktree(repo, join(data, 'w'), 'bbbbbbbb-1', 'index', 'kestrel');
    writeFileSync(join(wt.path, 'a.txt'), 'changed\n');
    writeFileSync(join(wt.path, 'untracked.txt'), 'u\n');
    const index = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: wt.path }).toString().trim() + '/index';
    const before = readFileSync(index);
    const files = await changedFiles(wt.path, wt.base);
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'untracked.txt']);
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wt.path }).toString()).toContain('?? untracked.txt');
    expect(existsSync(index + '.lock')).toBe(false);
  });

  it('refuses a worktrees folder inside a git work tree', async () => {
    const repo = makeRepo();
    const other = makeRepo();
    await expect(createWorktree(repo, join(other, 'worktrees'), 'cccccccc-1', 'x', 'kestrel')).rejects.toThrow(/inside the git work tree/);
    mkdirSync(join(other, 'unused'), { recursive: true });
  });
});

describe('readChanges and a path git cannot add', () => {
  it('lists every other new file, and says what it left out, when a folder is a repository of its own with no commit', async () => {
    const repo = makeRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    mkdirSync(join(repo, 'nested'));
    execFileSync('git', ['init', '-q'], { cwd: join(repo, 'nested') });
    writeFileSync(join(repo, 'nested', 'f.txt'), 'x\n');

    const read = await readChanges(repo, base);

    expect(read.files.map((f) => f.path)).toEqual(['new.txt']);
    expect(read.unlisted).toMatch(/^Not every new file could be listed: .*nested/);
    expect((await changedFiles(repo, base)).map((f) => f.path)).toEqual(['new.txt']);
  });

  it('says nothing is unlisted when every new file can be added', async () => {
    const repo = makeRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    writeFileSync(join(repo, 'new.txt'), 'n\n');

    expect(await readChanges(repo, base)).toMatchObject({ files: [{ path: 'new.txt', status: 'A' }], unlisted: null });
  });
});

describe('readChanges and the user\'s own git diff settings', () => {
  // Each of these changes what `git diff` prints; with any of them set the list used to come back empty.
  const settings: Array<[string, string]> = [
    ['diff.mnemonicPrefix', 'true'],
    ['diff.noprefix', 'true'],
    ['diff.srcPrefix', 'x/'],
    ['diff.dstPrefix', 'y/'],
    ['diff.relative', 'true'],
    ['color.diff', 'always'],
  ];
  it.each(settings)('lists an edited, a new and a deleted file with %s = %s', async (key, value) => {
    const repo = makeRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'kept.txt'), 'k\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'more'], { cwd: repo });
    execFileSync('git', ['config', key, value], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'n\n');

    const read = await readChanges(repo, base);

    expect(read.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A new.txt', 'A sub/kept.txt', 'M a.txt']);
    expect(read.unlisted).toBeNull();
    expect(read.files.every((f) => f.diff.startsWith(`diff --git a/${f.path} b/${f.path}`))).toBe(true);
  });

  it('lists a file whose name has an accent, which git would otherwise quote', async () => {
    const repo = makeRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    writeFileSync(join(repo, 'café.txt'), 'c\n');

    expect((await readChanges(repo, base)).files.map((f) => f.path)).toEqual(['café.txt']);
  });
});

describe('splitDiff', () => {
  it('splits per file and detects the status', () => {
    const text = 'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\ndiff --git a/y b/y\ndeleted file mode 100644\n--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-b\n';
    expect(splitDiff(text).map((f) => [f.path, f.status])).toEqual([['x', 'A'], ['y', 'D']]);
    expect(splitDiff('')).toEqual([]);
  });
});

describe('changedFiles and racily clean files', () => {
  it('lists an edit made in the same second as the last index write, at the same size, read a second later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-racy-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    const base = git('rev-parse', 'HEAD');
    // Same size, written right after the index: its stat matches the entry to the second.
    writeFileSync(join(dir, 'a.txt'), 'b\n');
    // Past the next second boundary, a scratch index stamped "now" would no longer look racy.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await changedFiles(dir, base)).map((f) => f.path)).toEqual(['a.txt']);
  });
});
