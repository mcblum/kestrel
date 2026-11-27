// What a worker node checks before it accepts a start that clones a project (worker-nodes.md section 9; item 64), in
// order, each refused in the words of shared/project-clone.ts before anything is started or cloned: the project can be
// cloned at all, the node has a key of its own, there is room on the disk, and the git host lets the node's key read
// every repository (one `git ls-remote` each, at once, with a timeout: what it lists also says whether a base branch
// asked for is on `origin`). Every way to learn a fact is passed in, so the order and the words are tested without git.
import { execFile } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import type { Project } from '../model.ts';
import { Refused } from '../refused.ts';
import { gitEnv } from '../git.ts';
import { baseRefusal, CLONE_DISK_MIN_BYTES, cloneRefusal, clonePlanOf, hostSilentRefusal, keyCannotReadRefusal, lowDiskRefusal, LS_REMOTE_TIMEOUT_MS, noKeyRefusal, type ClonePlan } from '../shared/project-clone.ts';

/** What `git ls-remote --heads` said: the branches, that the key may not read it, or nothing in time. */
export type LsRemote = { ok: true; heads: string[] } | { ok: false; why: 'denied' | 'timeout' };

export interface CloneProbe {
  /** Whether the node has its own key (`kestrel node git`) that its git uses. */
  keyReady(): boolean;
  /** Free bytes where the clones are kept (the nearest folder that exists). */
  freeBytes(): number;
  lsRemote(url: string, timeoutMs: number): Promise<LsRemote>;
}

/** The branch names of `git ls-remote --heads` output. Pure. */
export const headsOf = (out: string): string[] => out.split('\n').flatMap((line) => line.match(/\trefs\/heads\/(.+)$/)?.[1] ?? []);

/** Asks the git host, with Kestrel's git environment (the node's key), never a terminal prompt. */
export function lsRemote(url: string, timeoutMs: number): Promise<LsRemote> {
  return new Promise((resolve) => {
    execFile('git', ['ls-remote', '--heads', url], { env: gitEnv(), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (!error) return resolve({ ok: true, heads: headsOf(stdout) });
      resolve({ ok: false, why: (error as { killed?: boolean }).killed ? 'timeout' : 'denied' });
    });
  });
}

/** The real probe: free disk at `where` (the clones folder, or the nearest folder above it that exists), and whether the node's key is made. */
export function cloneProbe(where: string, keyReady: () => boolean): CloneProbe {
  return {
    keyReady,
    freeBytes: () => {
      for (let dir = where; ; dir = dir.replace(/\/[^/]*$/, '') || '/') {
        if (existsSync(dir)) {
          const fs = statfsSync(dir);
          return fs.bavail * fs.bsize;
        }
        if (dir === '/') return Number.POSITIVE_INFINITY;
      }
    },
    lsRemote,
  };
}

export interface CloneCheck {
  /** How the node is named in the words ("Worker node 1"). */
  node: string;
  /** Projects kept off Kestrel Connect. */
  keptOff: readonly string[];
  /** A base branch the starting device asked for, checked on the first repository's `origin`. */
  base?: string;
  probe: CloneProbe;
}

/** The plan to clone `project`, or `Refused` with the first reason it cannot be, before anything is made. */
export async function checkClone(project: Project, check: CloneCheck): Promise<ClonePlan> {
  const refusal = cloneRefusal(project, check.keptOff);
  if (refusal) throw new Refused(refusal);
  const plan = clonePlanOf(project);
  if (!plan.ok) throw new Refused(plan.reason);
  if (!check.probe.keyReady()) throw new Refused(noKeyRefusal(check.node));
  const free = check.probe.freeBytes();
  if (free < CLONE_DISK_MIN_BYTES) throw new Refused(lowDiskRefusal(check.node, free));
  const answers = await Promise.all(plan.plan.repos.map((r) => check.probe.lsRemote(r.url, LS_REMOTE_TIMEOUT_MS)));
  answers.forEach((answer, i) => {
    const key = plan.plan.repos[i]!.key;
    if (!answer.ok) throw new Refused(answer.why === 'timeout' ? hostSilentRefusal(check.node, key) : keyCannotReadRefusal(check.node, key));
  });
  const first = answers[0];
  const base = first?.ok ? baseRefusal(check.base, first.heads, project) : null;
  if (base) throw new Refused(base);
  return plan.plan;
}
