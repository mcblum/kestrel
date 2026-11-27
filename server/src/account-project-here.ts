// A project another computer of the account lists, and no project of this computer is, may still be on this
// disk: cloned by hand, or by the set-up list, and never added to Kestrel. This finds that folder, so the
// project's page can offer to add it instead of telling the person to clone what they already have
// (account-sessions.md, 10.2). It looks only where the other computer has it under the home folder
// (`~/Code/wren`), and counts a folder only when one of its remotes is one of the project's repositories.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { remotesOfConfig, remoteUrls } from './git.ts';

export { remotesOfConfig };
import type { Project } from './model.ts';
import { homePathHere } from './setup-actions/execute.ts';
import { repositoryShortName } from './shared/account-projects.ts';
import { repositoryKey } from './shared/knowledge.ts';
import { Refused } from './refused.ts';
import { homePath } from './shared/setup-record.ts';

export interface FolderHere {
  /** The folder on this computer. */
  path: string;
  /** As it is shown: `~/Code/wren`. */
  shown: string;
}

export interface HereDeps {
  home: string;
  isFolder(path: string): Promise<boolean>;
  /** A folder's remotes, asked of git. */
  remotes(path: string): Promise<string[]>;
  /** The folders directly inside `dir` with the remotes each one's own git config names; none when it cannot be read. */
  clonesIn(dir: string): Promise<{ path: string; remotes: string[] }[]>;
}

/** At most this many parent folders are looked through, and this many folders in each. */
export const PARENTS_MAX = 8;
export const CHILDREN_MAX = 400;

async function clonesIn(dir: string): Promise<{ path: string; remotes: string[] }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).slice(0, CHILDREN_MAX);
  const read = await Promise.all(
    folders.map(async (e) => {
      const path = join(dir, e.name);
      // Its own config file: no program is run per folder, and nothing secret is opened.
      const config = await readFile(join(path, '.git', 'config'), 'utf8').catch(() => null);
      return config === null ? null : { path, remotes: remotesOfConfig(config) };
    }),
  );
  return read.filter((r) => r !== null);
}

const real: HereDeps = {
  home: homedir(),
  isFolder: (path) => stat(path).then((s) => s.isDirectory(), () => false),
  remotes: remoteUrls,
  clonesIn,
};

const isOneOf = (remotes: readonly string[], repos: readonly string[]): boolean => remotes.some((url) => {
  const key = repositoryKey(url);
  return key !== null && repos.includes(key);
});

/**
 * The first folder of this computer that is `project`'s repository, or null. Looked for where the other
 * computer has it, then among the folders beside it there and beside this computer's own projects
 * (`beside`: their folders), as a clone made by hand is often named after the repository, not the project.
 */
export async function folderHere(project: Pick<Project, 'elsewhere'>, beside: readonly string[] = [], deps: HereDeps = real): Promise<FolderHere | null> {
  const where = project.elsewhere;
  if (!where || where.repos.length === 0) return null;
  const found = (path: string): FolderHere => ({ path, shown: homePath(path, deps.home) });
  const recorded = where.folders.flatMap((f) => (f.path ? (homePathHere(f.path, deps.home) ?? []) : []));
  for (const path of recorded) {
    if (!(await deps.isFolder(path))) continue;
    if (isOneOf(await deps.remotes(path).catch(() => []), where.repos)) return found(path);
  }
  const parents = [...new Set([...recorded, ...beside].map((path) => dirname(path)))].filter((dir) => dir !== deps.home && dir !== dirname(dir)).slice(0, PARENTS_MAX);
  for (const dir of parents) {
    const clone = (await deps.clonesIn(dir).catch(() => [])).find((c) => isOneOf(c.remotes, where.repos));
    if (clone) return found(clone.path);
  }
  return null;
}

/**
 * The folder the person chose for a project another computer lists: it must be that repository, or the two
 * would be listed as two projects. Returns the folder; throws why not.
 */
export async function chosenFolderHere(project: Pick<Project, 'name' | 'elsewhere'>, path: string, deps: HereDeps = real): Promise<string> {
  const repos = project.elsewhere?.repos ?? [];
  if (!(await deps.isFolder(path))) throw new Refused(`${path} is not a folder on this computer.`);
  const remotes = await deps.remotes(path).catch(() => []);
  if (isOneOf(remotes, repos)) return path;
  const wanted = repos[0] ? repositoryShortName(repos[0]) : project.name;
  throw new Refused(remotes.length === 0 ? `${path} is not a clone of ${wanted}: it has no git remote.` : `${path} is not a clone of ${wanted}. It is ${repositoryKey(remotes[0]) ?? 'another repository'}.`);
}

/**
 * What looking for `project` at its recorded places found, step by step, for the log: a clone that is here and
 * was missed can then be traced. Repository keys only, never a remote's address.
 */
export async function lookReport(project: Pick<Project, 'elsewhere'>, deps: HereDeps = real): Promise<string> {
  const where = project.elsewhere;
  if (!where) return 'not a project of another computer';
  const steps = await Promise.all(
    where.folders.map(async (f) => {
      // Folders are named, never given by path: this goes to the log (a node's log is read on a shared machine).
      if (!f.path) return `${f.name}: no place under the home folder was recorded`;
      const path = homePathHere(f.path, deps.home);
      if (!path) return `${f.name}: not under this home folder`;
      if (!(await deps.isFolder(path))) return `${f.name}: no such folder here`;
      const remotes = await deps.remotes(path).then((urls) => urls.map((url) => repositoryKey(url) ?? 'unreadable'), () => ['git could not list them']);
      return `${f.name}: remotes ${remotes.join(', ') || 'none'}`;
    }),
  );
  return `wanted ${where.repos.join(', ') || 'no repository'}; ${steps.join('; ') || 'no folder recorded'}`;
}
