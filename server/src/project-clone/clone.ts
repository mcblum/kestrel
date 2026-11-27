// A worker node clones a project it does not have when a session starts in it (worker-nodes.md section 9; item 64),
// after checks.ts has accepted it. Each repository is cloned from `origin`, with Kestrel's git environment (the node's
// own key), into a folder being made beside the others; only when every one is cloned is that folder given its name
// and registered as a project, so a clone that fails part-way leaves nothing behind. Registered by its folders, the
// project's repository keys make it the same account project every computer lists (account-view.ts), never its name.
// Two starts in one project at once clone it once: the second waits and gets the same project.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnv } from '../git.ts';
import type { Project } from '../model.ts';
import { createProject } from '../project-store.ts';
import { Refused } from '../refused.ts';
import { cloneFailedText, projectFolderWord, type ClonePlan } from '../shared/project-clone.ts';
import type { Workspace } from '../workspace.ts';

/** Clones one repository: git's words when it fails. */
export type CloneRun = (url: string, dest: string, opts: { branch?: string; signal?: AbortSignal }) => Promise<void>;

/** What git said when a clone failed: its first `fatal:` line, else its last line. */
const gitSaid = (stderr: unknown): string => {
  const lines = (typeof stderr === 'string' ? stderr : '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('fatal:')) ?? lines.at(-1) ?? '';
};

export const gitClone: CloneRun = (url, dest, { branch, signal }) =>
  new Promise((resolve, reject) => {
    const args = ['clone', '--quiet', ...(branch ? ['--branch', branch] : []), '--', url, dest];
    execFile('git', args, { env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, _stdout, stderr) => (error ? reject(new Error(gitSaid(stderr) || error.message)) : resolve()));
  });

export interface ClonerDeps {
  /** Where the clones are kept (`<data>/projects`). */
  root: string;
  workspace: Workspace;
  run?: CloneRun;
}

export class ProjectCloner {
  private readonly cloning = new Map<string, Promise<Project>>();

  constructor(private readonly deps: ClonerDeps) {}

  /**
   * The project these repositories are on this computer: one it already has (cloned meanwhile, or added by hand), else
   * cloned now and registered. `base`: the branch the first repository's clone is on. Throws `Refused` with why.
   */
  async projectFor(plan: ClonePlan, opts: { base?: string; signal?: AbortSignal } = {}): Promise<Project> {
    const key = plan.repos.map((r) => r.key).join('\n');
    const under = this.cloning.get(key);
    if (under) return under;
    const work = this.findOrClone(plan, opts);
    this.cloning.set(key, work);
    try {
      return await work;
    } finally {
      this.cloning.delete(key);
    }
  }

  /** A project of this computer that is one of these repositories, if any. */
  async existing(plan: ClonePlan): Promise<Project | undefined> {
    const wanted = new Set(plan.repos.map((r) => r.key));
    for (const project of (await this.deps.workspace.state()).projects) {
      if ((await this.deps.workspace.repos.ofProject(project)).some((k) => wanted.has(k))) return project;
    }
    return undefined;
  }

  private async findOrClone(plan: ClonePlan, opts: { base?: string; signal?: AbortSignal }): Promise<Project> {
    const had = await this.existing(plan);
    if (had) return had;
    await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.deps.root);
    const incoming = await mkdtemp(join(root, '.incoming-'));
    const run = this.deps.run ?? gitClone;
    try {
      for (const [i, repo] of plan.repos.entries()) {
        try {
          await run(repo.url, join(incoming, repo.folder), { ...(i === 0 && opts.base ? { branch: opts.base } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
        } catch (error) {
          throw new Refused(cloneFailedText(repo.key, error instanceof Error ? error.message : String(error)));
        }
      }
      const home = freeFolder(root, projectFolderWord(plan.name));
      await rename(incoming, home);
      try {
        const folders = plan.repos.map((r) => join(home, r.folder));
        folders.forEach((path) => this.deps.workspace.repos.forget(path));
        return await createProject(this.deps.workspace, { name: await this.freeName(plan.name), folders });
      } catch (error) {
        await rm(home, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }
  }

  /** The project's name, or with a number after it when a project here is already called that. */
  private async freeName(name: string): Promise<string> {
    const taken = new Set((await this.deps.workspace.state()).projects.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  }
}

/** `<root>/<word>`, or `<word>-2` and on when a folder of that name is already there. */
function freeFolder(root: string, word: string): string {
  let path = join(root, word);
  for (let n = 2; existsSync(path); n++) path = join(root, `${word}-${n}`);
  return path;
}
