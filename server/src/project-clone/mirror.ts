// A worker node mirrors the account's projects (worker-nodes.md section 9.3): one reconciler, on a node only, that
// works out what is missing from the account's projects as the node's view has them and clones each with the one
// `ProjectCloner` the dispatcher uses, after the one `checkClone`. It holds no list of what to clone: every pass
// derives it again (shared/project-mirror.ts `mirrorOrder`). What it keeps, in memory only, is why a project was not
// cloned (the refusal's own words, until the next pass), what is being cloned now, and when each clone was last
// fetched.
//
// - When: at start, after each reading of the account's projects feed (the link coming up, the service saying
//   `changed`, the devices changing), and when `kestrel node git` was carried out. Never on a timer.
// - How: at most `MIRROR_CLONES_AT_ONCE` at once, most recent first. Too little disk stops the pass.
// - Fresh: a mirrored clone is fetched when another computer's session in it changes, at most once per project per
//   `MIRROR_FETCH_MIN_MS`.
// - Leaving: a clone the account no longer has elsewhere, or kept off here, is deleted only when no session is in it
//   (`keptReason`); otherwise it stays, a project of the node's own, and `status` names it.
// - Its agents are told of what it has not cloned by `rows` (shared/project-clone.ts `notClonedRows`), and a tool that
//   names such a project clones it first through `cloneNamed`.
//
// The log never names a project or a path (9.1): counts only.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import type { NodeClones } from '../connect/dispatcher.ts';
import { gitEnv } from '../git.ts';
import type { Project, Session } from '../model.ts';
import { worktreeWork } from '../node-control/uninstall-node.ts';
import { Refused } from '../refused.ts';
import type { AccountHead } from '../shared/machines.ts';
import type { NodeStatusInputs } from '../shared/node-status.ts';
import type { WorktreeWork } from '../shared/node-uninstall.ts';
import { CLONE_DISK_MIN_BYTES, cloneRefusal, isKeptOff, lowDiskRefusal, notClonedRows, type NotClonedRow } from '../shared/project-clone.ts';
import { fetchDue, keptReason, leavingClone, MIRROR_CLONES_AT_ONCE, mirrorOrder } from '../shared/project-mirror.ts';
import type { Workspace } from '../workspace.ts';
import { checkClone } from './checks.ts';
import type { NodeProjectPrefsStore } from './prefs.ts';

/** How long one fetch of a mirrored clone may take. */
export const MIRROR_FETCH_TIMEOUT_MS = 60_000;

export type MirrorFetch = (folder: string) => Promise<void>;

/** `git fetch` of everything `origin` has, with Kestrel's git environment (the node's key), never a prompt. */
export const fetchOrigin: MirrorFetch = (folder) =>
  new Promise((resolve, reject) => {
    execFile('git', ['fetch', '--quiet', '--prune', 'origin'], { cwd: folder, env: gitEnv(), timeout: MIRROR_FETCH_TIMEOUT_MS, encoding: 'utf8' }, (error) => (error ? reject(error) : resolve()));
  });

export interface MirrorDeps {
  workspace: Pick<Workspace, 'view' | 'state' | 'repos' | 'removeProject' | 'accountProjects' | 'account'>;
  /** The one cloner and probe this server has: the dispatcher's too (connect/link/start.ts `nodeClones`). */
  clones: NodeClones;
  /** Where clones are kept (`<data>/projects`). */
  root: string;
  /** How the node is named in the words ("Worker node 1"). */
  here(): string;
  keptOff(): readonly string[];
  prefs: Pick<NodeProjectPrefsStore, 'current'>;
  /** The worktrees' work, as `uninstall` counts it. */
  work?(sessions: readonly Session[]): Promise<WorktreeWork[]>;
  fetch?: MirrorFetch;
  now?(): number;
  log?(text: string): void;
}

/** What a session of a project is, for the leaving rule: running or waiting on someone counts as live. */
const isLive = (s: Pick<Session, 'state'>): boolean => s.state === 'running' || s.state === 'attention';

/** What the runtime and its tools use of the mirror. */
export type NodeProjectsTools = Pick<ProjectMirror, 'rows' | 'cloneNamed' | 'reconcile' | 'status'>;

export class ProjectMirror {
  /** Why each account project (by its id in the view) was not cloned at the last try. */
  private readonly why = new Map<string, string>();
  /** The account projects being cloned now, by their id in the view, with their repositories. */
  private readonly cloning = new Map<string, string[]>();
  /** When each clone (by its project id here) was last fetched. */
  private readonly fetchedAt = new Map<string, number>();
  private kept: { name: string; why: string }[] = [];
  private lowDisk: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private offs: (() => void)[] = [];
  private readonly idleListeners = new Set<() => void>();

  constructor(private readonly deps: MirrorDeps) {}

  /** How many clones run now: a node's update waits for them (worker-nodes.md 4.2). */
  cloningNow(): number {
    return this.cloning.size;
  }

  /** Told each time the last clone under way ends. Returns the undo. */
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => void this.idleListeners.delete(listener);
  }

  /** Runs a pass now, and one after each reading of the projects feed; fetches when another computer's session changes. */
  start(): void {
    this.offs = [this.deps.workspace.accountProjects.onRead(() => void this.reconcile()), this.deps.workspace.account.onHeads((heads) => void this.headsChanged(heads))];
    void this.reconcile();
  }

  stop(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
  }

  /** One pass, or, while one runs, one more after it. Never throws. */
  reconcile(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      do {
        this.again = false;
        await this.pass().catch((error: unknown) => this.log(`the projects pass failed: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again);
    })();
    this.running = run.finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** What `list_projects` and the standing instruction add on a node: the account projects not cloned here. */
  async rows(): Promise<NotClonedRow[]> {
    return notClonedRows('node', (await this.deps.workspace.view()).projects, this.deps.keptOff(), this.why, new Set(this.cloning.keys()));
  }

  /**
   * The project of the account named `given` (by name, or by one of its repositories), cloned here first: checked and
   * cloned as a start in it would be, through the same cloner, then this computer's project. Null when no project of
   * the account is called that; `Refused` with 9.1's words when it cannot be cloned.
   */
  async cloneNamed(given: string): Promise<Project | null> {
    const wanted = given.trim().toLowerCase();
    if (!wanted) return null;
    const target = (await this.deps.workspace.view()).projects.find((p) => p.away && (p.name.toLowerCase() === wanted || (p.elsewhere?.repos ?? []).some((k) => k.toLowerCase() === wanted)));
    return target ? this.cloneOne(target) : null;
  }

  /** The projects part of `kestrel node status` (shared/node-status.ts). */
  async status(): Promise<NonNullable<NodeStatusInputs['projects']>> {
    const [view, state, prefs] = await Promise.all([this.deps.workspace.view(), this.deps.workspace.state(), this.deps.prefs.current()]);
    const keptOff = this.deps.keptOff();
    const rows = notClonedRows('node', view.projects, keptOff, this.why, new Set(this.cloning.keys()));
    const off = new Set(keptOff);
    const notCloned = view.projects.flatMap((p) => {
      if (!p.away || this.cloning.has(p.id) || isKeptOff(p, off)) return [];
      const why = this.why.get(p.id) ?? cloneRefusal(p, keptOff);
      return why ? [{ name: p.name, why }] : [];
    });
    return { here: state.projects.length, notHere: rows.length, cloning: this.cloning.size, mode: prefs.projects, notCloned, kept: this.kept, lowDisk: this.lowDisk, where: this.deps.root };
  }

  // ---- the pass ------------------------------------------------------------------------------

  private async pass(): Promise<void> {
    await this.leave();
    if ((await this.deps.prefs.current()).projects !== 'every') return;
    const view = await this.deps.workspace.view();
    const queue = mirrorOrder(view.projects, view.sessions, this.deps.keptOff());
    this.lowDisk = null;
    let cloned = 0;
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next && !this.lowDisk; next = queue.shift()) {
        const free = this.deps.clones.probe.freeBytes();
        if (free < CLONE_DISK_MIN_BYTES) {
          this.lowDisk = lowDiskRefusal(this.deps.here(), free);
          return;
        }
        if (await this.cloneOne(next).then(() => true, () => false)) cloned++;
      }
    };
    await Promise.all(Array.from({ length: MIRROR_CLONES_AT_ONCE }, worker));
    const missing = queue.length + this.why.size;
    if (cloned > 0 || missing > 0 || this.lowDisk) this.log(`cloned ${cloned} project${cloned === 1 ? '' : 's'} of the account${missing > 0 ? `; ${missing} not cloned` : ''}${this.lowDisk ? '; stopped for lack of disk' : ''}`);
  }

  /** Checks and clones one account project; remembers why when it cannot be. */
  private async cloneOne(target: Project): Promise<Project> {
    try {
      const plan = await checkClone(target, { node: this.deps.here(), keptOff: this.deps.keptOff(), probe: this.deps.clones.probe });
      this.cloning.set(target.id, plan.repos.map((r) => r.key));
      const project = await this.deps.clones.cloner.projectFor(plan);
      this.why.delete(target.id);
      return project;
    } catch (error) {
      this.why.set(target.id, error instanceof Error ? error.message : String(error));
      throw error instanceof Refused ? error : new Refused(error instanceof Error ? error.message : String(error));
    } finally {
      this.cloning.delete(target.id);
      if (this.cloning.size === 0) for (const listener of this.idleListeners) listener();
    }
  }

  // ---- leaving -------------------------------------------------------------------------------

  /** Deletes the clones the account no longer has, when nothing is in them; names the rest for `status`. */
  private async leave(): Promise<void> {
    // Before the account was ever read (or after signing out), nothing is known to have left.
    if ((await this.deps.workspace.accountProjects.feedMark()) === null) return;
    const [view, state] = await Promise.all([this.deps.workspace.view(), this.deps.workspace.state()]);
    const keptOff = this.deps.keptOff();
    const everySession = [...state.sessions, ...state.archived.sessions];
    const kept: { name: string; why: string }[] = [];
    let deleted = 0;
    for (const project of view.projects) {
      if (project.away || !this.isClone(project) || !leavingClone(project, keptOff)) continue;
      const sessions = everySession.filter((s) => s.startedIn === project.id || s.landedIn === project.id);
      const work = await (this.deps.work ?? worktreeWork)(sessions);
      const why = keptReason(sessions.map((s) => ({ title: s.title, running: isLive(s) })), work);
      if (why) {
        kept.push({ name: project.name, why });
        continue;
      }
      await this.deps.workspace.removeProject(project.id);
      await Promise.all(this.homesOf(project).map((home) => rm(home, { recursive: true, force: true })));
      this.fetchedAt.delete(project.id);
      deleted++;
    }
    this.kept = kept;
    if (deleted > 0) this.log(`deleted ${deleted} clone${deleted === 1 ? '' : 's'} the account no longer has`);
  }

  /** The clones folder, as given and as it really is (a link resolved). */
  private roots(): string[] {
    try {
      return [this.deps.root, realpathSync(this.deps.root)];
    } catch {
      return [this.deps.root];
    }
  }

  /** Whether every folder of a project is under the clones folder: only a clone the node made is ever deleted. */
  private isClone(project: Pick<Project, 'folders'>): boolean {
    const roots = this.roots();
    return project.folders.length > 0 && project.folders.every((f) => roots.some((r) => f.path.startsWith(`${r}${sep}`)));
  }

  /** The project's own folder under the clones folder (`<root>/<project word>`), each once. */
  private homesOf(project: Pick<Project, 'folders'>): string[] {
    const roots = this.roots();
    const homes = project.folders.flatMap((f) => {
      const root = roots.find((r) => f.path.startsWith(`${r}${sep}`));
      if (!root) return [];
      const top = relative(root, f.path).split(sep)[0];
      return top && top !== '..' ? [`${root}${sep}${top}`] : [dirname(f.path)];
    });
    return [...new Set(homes)];
  }

  // ---- fresh ---------------------------------------------------------------------------------

  /** Another computer's sessions changed: fetch the clones of their projects, each at most once per interval. */
  private async headsChanged(heads: readonly AccountHead[]): Promise<void> {
    const wanted = new Set(heads.flatMap((h) => h.repos));
    if (wanted.size === 0) return;
    const now = (this.deps.now ?? Date.now)();
    try {
      for (const project of (await this.deps.workspace.state()).projects) {
        if (!this.isClone(project) || !fetchDue(this.fetchedAt.get(project.id), now)) continue;
        if (!(await this.deps.workspace.repos.ofProject(project)).some((k) => wanted.has(k))) continue;
        this.fetchedAt.set(project.id, now);
        const fetch = this.deps.fetch ?? fetchOrigin;
        await Promise.all(project.folders.filter((f) => f.isGit).map((f) => fetch(f.path).catch(() => this.log('a fetch of a mirrored clone failed; the next session there fetches again'))));
      }
    } catch (error) {
      this.log(`could not fetch the mirrored clones: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private log(text: string): void {
    (this.deps.log ?? ((t: string) => console.log(`[kestrel] projects: ${t}`)))(text);
  }
}
