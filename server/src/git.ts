// Git through the git CLI ("borrow, do not build"): repository checks, per-session worktrees,
// and the changed-file list with unified diffs. Worktrees live under Kestrel's data directory,
// never inside the project.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, ProjectChanges, ProjectFolder } from './model.ts';
import { branchName, branchSlug, shortId } from './shared/branch-prefix.ts';
import { NO_FOLDER_YET } from './shared/project-folders.ts';
import { Refused } from './workspace.ts';

const run = promisify(execFile);
const MAX_DIFF_BYTES = 200_000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, env: { ...GIT_ENV, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (opts.allowFail) return '';
    const stderr = (error as { stderr?: string }).stderr?.trim();
    // Named by its subcommand, past any `-c name=value` given before it.
    let at = 0;
    while (args[at] === '-c') at += 2;
    throw new Refused(`git ${args[at] ?? args[0]} failed in ${cwd}: ${stderr || (error as Error).message}`);
  }
}

/** The repository root when `path` is inside a work tree, else null. */
export async function repoRoot(path: string): Promise<string | null> {
  const out = (await git(path, ['rev-parse', '--show-toplevel'], { allowFail: true })).trim();
  return out ? realpathSync(out) : null;
}

/**
 * For the root of a linked worktree (`git worktree add`), the repository it belongs to: the main
 * checkout's folder, or the bare repository itself. Null when `root` is the main checkout. A
 * worktree shares its repository's git directory, so `--git-common-dir` differs from `--git-dir`.
 */
export async function mainCheckoutOf(root: string): Promise<string | null> {
  const ask = async (flag: string) => (await git(root, ['rev-parse', '--path-format=absolute', flag], { allowFail: true })).trim();
  const [own, common] = await Promise.all([ask('--git-dir'), ask('--git-common-dir')]);
  if (!own || !common) return null;
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const commonDir = real(common);
  if (real(own) === commonDir) return null;
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
}

/**
 * Where a worktree starts when it is not the project's HEAD: a fork starts at the old session's
 * commit, with that session's base and the branch its base lies on, so its changes read the same.
 */
export interface WorktreeStart {
  head: string;
  base: string;
  baseRef: string | null;
  /** What its branch is named under, in place of the user's own prefix: a review's branch is Kestrel's, not a branch of the user's work. */
  prefix?: string;
}

/**
 * A new worktree on a new branch cut from the project's current HEAD (or from `start`), named
 * `<prefix>/<title>-<id>` (shared/branch-prefix.ts; '' for no prefix). The caller resolves the
 * prefix from the settings. The base commit is kept in the branch's own git config so the diff can
 * always be taken against it.
 */
export function createWorktree(repoPath: string, worktreesDir: string, sessionId: string, title: string, prefix: string, start?: WorktreeStart): Promise<Worktree> {
  return oneAtATime(repoPath, () => addWorktree(repoPath, worktreesDir, sessionId, title, prefix, start));
}

/** Where a session's worktree stands now, for a fork to start from: its commit, its base, and the branch that base lies on. */
export async function worktreeStart(worktreePath: string, branch: string): Promise<WorktreeStart> {
  const head = await headCommit(worktreePath);
  const base = (await baseOf(worktreePath, branch)) ?? head;
  const baseRef = (await git(worktreePath, ['config', '--get', `branch.${branch}.kestrelbaseref`], { allowFail: true })).trim();
  return { head, base, baseRef: baseRef || null };
}

const repoQueues = new Map<string, Promise<unknown>>();

/**
 * Worktree changes run one at a time per repository: two at once (sessions started together, a
 * delegate's children) fight over `.git/config.lock` and one fails.
 */
export function oneAtATime<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const next = (repoQueues.get(repoPath) ?? Promise.resolve()).then(work);
  const tail = next.catch(() => undefined);
  repoQueues.set(repoPath, tail);
  void tail.then(() => repoQueues.get(repoPath) === tail && repoQueues.delete(repoPath));
  return next;
}

async function addWorktree(repoPath: string, worktreesDir: string, sessionId: string, title: string, prefix: string, start?: WorktreeStart): Promise<Worktree> {
  const head = start?.head ?? (await git(repoPath, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).trim();
  if (!head) throw new Refused('This repository has no commits yet. Make a first commit, then start the session.');
  const branch = branchName(start?.prefix ?? prefix, title, sessionId);
  const path = join(worktreesDir, `${branchSlug(repoPath.split('/').pop() ?? 'repo')}-${shortId(sessionId)}`);
  mkdirSync(worktreesDir, { recursive: true });
  // Tools that walk up for config (pnpm, tsconfig, eslint) must not find another repo's files.
  const enclosing = await repoRoot(worktreesDir);
  if (enclosing) throw new Refused(`The worktrees folder ${worktreesDir} is inside the git work tree ${enclosing}. Set KESTREL_DATA_DIR to a folder outside any repository.`);
  if (existsSync(path)) throw new Refused(`A worktree already exists at ${path}.`);
  await git(repoPath, ['worktree', 'add', '-b', branch, path, head]);
  const base = start?.base ?? head;
  await git(repoPath, ['config', `branch.${branch}.kestrelbase`, base]);
  // The branch the worktree was cut from: the line its base moves along when it is rebased (`movedBase`).
  const from = start ? start.baseRef : await currentBranch(repoPath);
  if (from) await git(repoPath, ['config', `branch.${branch}.kestrelbaseref`, from], { allowFail: true });
  return { path: realpathSync(path), branch, base };
}

/**
 * The base commit of a session's branch: the one recorded when its worktree was made. A branch the
 * agent (or the user) made inside the worktree afterwards has none recorded, so it is recovered
 * (`recoveredBase`) and recorded under the new name; without that the session would show no
 * changes at all. Null only when nothing can be recovered.
 */
export async function baseOf(worktreePath: string, branch: string): Promise<string | null> {
  const key = `branch.${branch}.kestrelbase`;
  const recorded = (await git(worktreePath, ['config', '--get', key], { allowFail: true })).trim();
  if (recorded) return movedBase(worktreePath, branch, recorded);
  const recovered = await recoveredBase(worktreePath);
  if (recovered) await git(worktreePath, ['config', key, recovered], { allowFail: true });
  return recovered && movedBase(worktreePath, branch, recovered);
}

/** The branches a session's base lies on: the one its worktree was cut from, and the remote's default. Never the session's own. */
async function baseLines(worktreePath: string, branch: string): Promise<string[]> {
  const [from = '', remoteHead = ''] = (
    await Promise.all([
      git(worktreePath, ['config', '--get', `branch.${branch}.kestrelbaseref`], { allowFail: true }),
      git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }),
    ])
  ).map((out) => out.trim());
  const lines = [from, from && `origin/${from}`, remoteHead, remoteHead.replace(/^origin\//, '')];
  return [...new Set(lines.filter((ref) => ref && ref !== branch && ref !== `origin/${branch}`))];
}

/**
 * The base as it stands now. The recorded base is the commit the worktree was cut from; once the
 * branch is rebased onto (or merges in) newer work from the branch it came from, comparing with
 * that old commit counts everything that landed there since as this session's change (124 files
 * for a change of 19). So the base moves with the branch: to the nearest point where HEAD meets one
 * of its base lines, when that point is past the recorded base, or when the recorded base is no
 * longer in HEAD's history at all (it was rewritten by the rebase). A branch that has landed (all
 * of it is in a base line) keeps its recorded base, so what it changed can still be seen.
 */
async function movedBase(worktreePath: string, branch: string, recorded: string): Promise<string> {
  const lines = await baseLines(worktreePath, branch);
  if (lines.length === 0) return recorded;
  const [head, ...forks] = (
    await Promise.all([git(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }), ...lines.map((ref) => git(worktreePath, ['merge-base', 'HEAD', ref], { allowFail: true }))])
  ).map((out) => out.trim());
  // The usual case, a branch that was never rebased: every line meets it at the recorded base.
  const moved = [...new Set(forks)].filter((fork) => fork && fork !== head && fork !== recorded);
  if (!head || moved.length === 0) return recorded;
  const recordedDistance = await distanceFrom(worktreePath, recorded);
  let nearest = { sha: recorded, distance: recordedDistance };
  for (const fork of moved) {
    if (recordedDistance !== null && !(await isAncestor(worktreePath, recorded, fork))) continue;
    const distance = await distanceFrom(worktreePath, fork);
    if (distance !== null && (nearest.distance === null || distance < nearest.distance)) nearest = { sha: fork, distance };
  }
  return nearest.sha;
}

/** How many commits `head` has that `base` does not, or null when `base` is not in `head`'s history. */
async function distanceFrom(cwd: string, base: string): Promise<number | null> {
  if (!(await isAncestor(cwd, base, 'HEAD'))) return null;
  const count = Number((await git(cwd, ['rev-list', '--count', `${base}..HEAD`], { allowFail: true })).trim());
  return Number.isInteger(count) ? count : null;
}

/**
 * A base for a branch that has none recorded. First the bases Kestrel recorded for other branches
 * of this repository that are in this worktree's history: the nearest one is where this session
 * started (its first branch still carries it). Failing that, where the worktree left the remote's
 * default branch.
 */
async function recoveredBase(worktreePath: string): Promise<string | null> {
  const listed = await git(worktreePath, ['config', '--get-regexp', '^branch\\..*\\.kestrelbase$'], { allowFail: true });
  const bases = [...new Set(listed.split('\n').map((line) => line.trim().split(/\s+/).pop() ?? '').filter((sha) => /^[0-9a-f]{7,64}$/i.test(sha)))];
  let nearest: { sha: string; distance: number } | null = null;
  for (const sha of bases) {
    const distance = await distanceFrom(worktreePath, sha);
    if (distance !== null && (!nearest || distance < nearest.distance)) nearest = { sha, distance };
  }
  if (nearest) return nearest.sha;
  const remoteHead = (await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })).trim();
  for (const ref of [remoteHead, 'origin/main', 'origin/master'].filter(Boolean)) {
    const fork = (await git(worktreePath, ['merge-base', 'HEAD', ref], { allowFail: true })).trim();
    if (fork) return fork;
  }
  return null;
}

/**
 * What makes `git diff` answer the same on every computer. A user's own git settings change the
 * text: `diff.mnemonicPrefix` writes `c/` and `w/` where `a/` and `b/` are expected, `diff.noprefix`
 * writes no prefix at all, `diff.srcPrefix` and `diff.dstPrefix` anything, and `diff.relative` cuts
 * the paths. `splitDiff` reads `diff --git a/… b/…`, so with any of those set it found no file and
 * the Changes list was empty beside a count of uncommitted files (Matt's work computer, 2026-11-24).
 * Given on the command line, these win over the settings. Use them for every diff Kestrel reads.
 */
export const PLAIN_DIFF: readonly string[] = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative'];
/** Before `diff`: file names as they are, not escaped as octal inside quotes (an accented name would not be matched). */
export const PLAIN_PATHS: readonly string[] = ['-c', 'core.quotePath=false'];

/** Split `git diff` output into one entry per file. Pure. */
export function splitDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!header) continue;
    const status = /^new file mode/m.test(chunk) ? 'A' : /^deleted file mode/m.test(chunk) ? 'D' : 'M';
    const diff = chunk.length > MAX_DIFF_BYTES ? `${chunk.slice(0, MAX_DIFF_BYTES)}\n\\ diff truncated by Kestrel\n` : chunk;
    files.push({ path: header[2]!, status, diff });
  }
  return files;
}

/** What a worktree has that its base does not, and what of it could not be listed. */
export interface ChangesRead {
  files: ChangedFile[];
  /** Why some new files are missing from `files`, in git's words; null when every one is there. */
  unlisted: string | null;
}

/**
 * Marks every new file intent-to-add in the scratch index `env` selects. A path git cannot take (a
 * folder that is a repository of its own with no commit yet, say) is skipped, never allowed to stop
 * the rest: without `--ignore-errors` one such path left every new file out, and a session whose
 * changes were all new files showed none. Returns what was skipped, in git's words, or null.
 */
async function markNewFiles(worktreePath: string, env: Record<string, string>): Promise<string | null> {
  try {
    await run('git', ['add', '-A', '-N', '--ignore-errors', '.'], { cwd: worktreePath, env: { ...GIT_ENV, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const said = stderr.split('\n').filter((line) => /^(error|fatal): /.test(line)).map((line) => line.replace(/^(error|fatal): /, '').trim());
    return `Not every new file could be listed: ${said.join('; ') || (error as Error).message}`;
  }
}

/**
 * Everything that differs from the base: committed, uncommitted and new files, with what could not
 * be listed. The worktree's own index is never touched (the agent's git commands use it): new files
 * are marked intent-to-add in a private copy of the index, selected with GIT_INDEX_FILE.
 */
export async function readChanges(worktreePath: string, base: string): Promise<ChangesRead> {
  const realIndex = (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'kestrel-index-'));
  const copy = join(scratch, 'index');
  try {
    const source = isAbsolute(realIndex) ? realIndex : resolve(worktreePath, realIndex);
    if (existsSync(source)) {
      copyFileSync(source, copy);
      // Keep the index's own times: git re-reads a file whose stat matches its entry only when the
      // file is as new as the index ("racy git"). A copy stamped now would hide an edit made in the
      // same second as the last index write that kept the file's size.
      const { atime, mtime } = statSync(source);
      utimesSync(copy, atime, mtime);
    }
    const env = { GIT_INDEX_FILE: copy };
    const unlisted = await markNewFiles(worktreePath, env);
    const text = await git(worktreePath, [...PLAIN_PATHS, 'diff', ...PLAIN_DIFF, '--no-renames', base], { env });
    const files = splitDiff(text);
    // Never an empty list for a diff that says something: a form of output this cannot read is a problem to show, not "no changes".
    if (files.length === 0 && /^diff --git /m.test(text)) throw new Refused(`git diff in ${worktreePath} answered in a form Kestrel could not read, so the changed files cannot be listed. Its first line was: ${text.slice(0, text.indexOf('\n') === -1 ? 200 : Math.min(200, text.indexOf('\n')))}`);
    return { files, unlisted };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The files `readChanges` lists, for a caller with nowhere to say what could not be listed. */
export async function changedFiles(worktreePath: string, base: string): Promise<ChangedFile[]> {
  return (await readChanges(worktreePath, base)).files;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await oneAtATime(repoPath, () => git(repoPath, ['worktree', 'remove', '--force', worktreePath]));
}

/** The branch checked out in `path`, or null when HEAD is detached or there is no repository. */
export async function currentBranch(path: string): Promise<string | null> {
  const out = (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })).trim();
  return out || null;
}

/** A project page's Changes: what in the main checkout differs from HEAD, new files included. Read only. */
export async function projectChanges(project: Pick<ProjectFolder, 'path' | 'isGit'> | null): Promise<ProjectChanges> {
  if (!project) return { isGit: false, branch: null, files: [], note: NO_FOLDER_YET };
  if (!project.isGit || !existsSync(project.path) || !(await repoRoot(project.path))) return { isGit: false, branch: null, files: [], note: 'Not a git repository' };
  const branch = await currentBranch(project.path);
  const head = (await git(project.path, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).trim();
  if (!head) return { isGit: true, branch, files: [], note: 'This repository has no commits yet.' };
  return { isGit: true, branch, files: await changedFiles(project.path, head), note: null };
}

/** `git rev-list --left-right --count A...B` output ("<only in A>\t<only in B>"). Null when it is not that. Pure. */
export function parseLeftRight(text: string): { left: number; right: number } | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  return match ? { left: Number(match[1]), right: Number(match[2]) } : null;
}

/** Commits on HEAD that `base` lacks (ahead) and commits in `base` that HEAD lacks (behind). Throws `Refused` when git cannot say. */
export async function aheadBehind(worktreePath: string, base: string): Promise<{ ahead: number; behind: number }> {
  const out = await git(worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`]);
  const counts = parseLeftRight(out);
  if (!counts) throw new Refused(`git rev-list gave an answer Kestrel cannot read: ${out.trim().slice(0, 80)}`);
  return { ahead: counts.right, behind: counts.left };
}

/** NUL-separated paths (`-z` output) as a list, without the empty end. Pure. */
export const splitPaths = (text: string): string[] => text.split('\0').filter((path) => path !== '');

/**
 * How many files differ from `base`: the files `changedFiles` lists, counted from names alone (no
 * diff text, no scratch index), so a sidebar row can ask cheaply. Tracked changes, committed or not,
 * plus new files git does not ignore.
 */
export async function changedFileCount(worktreePath: string, base: string): Promise<number> {
  const [tracked, untracked] = await Promise.all([
    git(worktreePath, ['diff', '--name-only', '-z', '--no-renames', base]),
    git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return new Set([...splitPaths(tracked), ...splitPaths(untracked)]).size;
}

/** How many files in the worktree have changes that are not committed (staged, unstaged or untracked). */
export async function uncommittedFiles(worktreePath: string): Promise<number> {
  const out = await git(worktreePath, ['status', '--porcelain']);
  return out.split('\n').filter((line) => line.trim() !== '').length;
}

/** The full id of the commit the worktree is on. */
export async function headCommit(worktreePath: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
}

/** Whether `commit` is in the history of `ref`. False when either is unknown. */
export async function isAncestor(cwd: string, commit: string, ref: string): Promise<boolean> {
  try {
    await run('git', ['merge-base', '--is-ancestor', commit, ref], { cwd, env: GIT_ENV });
    return true;
  } catch {
    return false;
  }
}

/** The URL of the `origin` remote, or null when there is none. */
export async function originUrl(path: string): Promise<string | null> {
  const out = (await git(path, ['remote', 'get-url', 'origin'], { allowFail: true })).trim();
  return out || null;
}

/** The remote addresses a git config file names, `origin` first. Pure. */
export function remotesOfConfig(config: string): string[] {
  const found = [...config.matchAll(/\[remote "([^"]+)"\][^\[]*?^\s*url\s*=\s*(\S+)\s*$/gm)].map((m) => ({ name: m[1]!, url: m[2]! }));
  return [...found.filter((r) => r.name === 'origin'), ...found.filter((r) => r.name !== 'origin')].map((r) => r.url);
}

/**
 * Every remote's address, `origin` first: a clone made from a mirror is still the same repository. Read from
 * the folder's own config file, which needs no program; git is asked only where there is none to read (a
 * worktree, a submodule), and then `origin` alone if that names nothing. Asking git for all of them was seen to
 * answer nothing in an installed app where the file plainly names a remote (0.0.33-beta.6).
 */
export async function remoteUrls(path: string): Promise<string[]> {
  const config = await readFile(join(path, '.git', 'config'), 'utf8').catch(() => null);
  if (config !== null) return remotesOfConfig(config);
  const out = await git(path, ['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
  const found = out.split('\n').flatMap((line) => {
    const at = line.indexOf(' ');
    return at > 0 && line.slice(at + 1).trim() ? [{ origin: line.slice(0, at) === 'remote.origin.url', url: line.slice(at + 1).trim() }] : [];
  });
  if (found.length > 0) return [...found.filter((r) => r.origin), ...found.filter((r) => !r.origin)].map((r) => r.url);
  const origin = await originUrl(path);
  return origin ? [origin] : [];
}

/**
 * Whether `sha` is in the history of the worktree's HEAD: a commit the session made or has. False when
 * there is no worktree or git cannot tell (Autopilot then treats a new head as somebody else's push).
 */
export async function commitIsHere(worktreePath: string | null | undefined, sha: string): Promise<boolean> {
  if (!worktreePath || !/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  try {
    await run('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: worktreePath, env: GIT_ENV });
    return true;
  } catch {
    return false;
  }
}
