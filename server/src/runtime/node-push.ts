// A worker node pushes a session's branch when a turn ends (worker-nodes.md 9.3). `nodePushStep`
// (shared/node-push.ts) decides from plain facts; this only reads them from git and carries the step out, after the
// turn and never blocking the next: each session's pushes run one after another, apart from its turns. A push the
// host refuses is a line in the session ("Could not push …") and, held in memory until that session's next push, a
// notification through `notificationsOf` (the push sender reads `failures`). It is tried again at the next turn's
// end, not before. Never forced; with the node's own git environment (`gitEnv()`, section 7).
import { execFile } from 'node:child_process';
import { git, gitEnv } from '../git.ts';
import type { Session } from '../model.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { nodePushStep, pushFailedText, pushSaid, type NodePushStep } from '../shared/node-push.ts';
import type { PushFailureNotice } from '../shared/notifications.ts';
import type { NodeProjectPrefsStore } from '../project-clone/prefs.ts';

/** How long one push may take. */
export const PUSH_TIMEOUT_MS = 120_000;

/** What the pusher asks git, so a test can stand in for it. */
export interface PushGit {
  /** Whether the repository has an `origin`. */
  hasOrigin(worktree: string): Promise<boolean>;
  /** The branch `origin`'s HEAD names ("main"), or null. */
  originDefault(worktree: string): Promise<string | null>;
  /** Commits on `branch` that no branch of `origin` has (unknown counts as one, so it is tried). */
  ahead(worktree: string, branch: string): Promise<number>;
  /** `git push origin <refspec>`: ok, or git's own line about why not. */
  push(worktree: string, refspec: string): Promise<{ ok: true } | { ok: false; said: string }>;
}

export const realPushGit: PushGit = {
  hasOrigin: async (worktree) => (await git(worktree, ['remote'], { allowFail: true })).split('\n').some((r) => r.trim() === 'origin'),
  originDefault: async (worktree) => {
    const ref = (await git(worktree, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })).trim();
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null;
  },
  ahead: async (worktree, branch) => {
    const count = Number((await git(worktree, ['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes=origin'], { allowFail: true })).trim());
    return Number.isInteger(count) ? count : 1;
  },
  push: (worktree, refspec) =>
    new Promise((resolve) => {
      execFile('git', ['push', '--quiet', 'origin', refspec], { cwd: worktree, env: gitEnv(), timeout: PUSH_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true });
        const killed = (error as { killed?: boolean }).killed;
        resolve({ ok: false, said: killed ? `git did not finish in ${PUSH_TIMEOUT_MS / 1000} seconds` : pushSaid(`${stderr}\n${stdout}`) });
      });
    }),
};

export interface NodePushDeps {
  kind: KestrelKind;
  sessions(): Promise<readonly Session[]>;
  prefs: Pick<NodeProjectPrefsStore, 'current'>;
  keptOff(): readonly string[];
  notice(sessionId: string, text: string, level: 'info' | 'warning' | 'error'): void;
  git?: PushGit;
  now?(): number;
  log?(text: string): void;
}

export class NodePusher {
  private readonly failed = new Map<string, PushFailureNotice>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly idleListeners = new Set<() => void>();

  constructor(private readonly deps: NodePushDeps) {}

  /** How many sessions have a push running or waiting now: a node's update waits for them (worker-nodes.md 4.2). */
  pushingNow(): number {
    return this.chains.size;
  }

  /** Told each time the last push under way ends. Returns the undo. */
  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => void this.idleListeners.delete(listener);
  }

  /** A turn of the session ended: push its branch after whatever push of it is still running. Never waited for. */
  turnOver(sessionId: string): Promise<void> {
    if (this.deps.kind !== 'node') return Promise.resolve();
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(() => this.pushOnce(sessionId)).catch((error: unknown) => this.log(`a push failed to run: ${error instanceof Error ? error.message : String(error)}`));
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
      if (this.chains.size === 0) for (const listener of this.idleListeners) listener();
    });
    return next;
  }

  /** Whether this node pushes: a node, with "Push each session's branch when a turn ends" on. */
  async on(): Promise<boolean> {
    return this.deps.kind === 'node' && (await this.deps.prefs.current()).push;
  }

  /** The pushes refused since each session's last push, for the push sender (shared/notifications.ts). */
  failures(): PushFailureNotice[] {
    return [...this.failed.values()];
  }

  /** Told when a push is refused or a refused one is cleared. Returns the undo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The step for a session, from git's facts (exported for the tests). */
  async stepFor(session: Session): Promise<NodePushStep> {
    const g = this.deps.git ?? realPushGit;
    const prefs = await this.deps.prefs.current();
    const where = session.worktreeDiscarded ? null : session.worktreePath;
    const base = { kind: this.deps.kind, on: prefs.push, session: { branch: where ? session.branch : null, ...(session.hostId ? { hostId: session.hostId } : {}), ...(session.review ? { review: true } : {}), ...(session.aside ? { aside: true } : {}) }, keptOff: session.startedIn !== null && this.deps.keptOff().includes(session.startedIn) };
    const early = nodePushStep({ ...base, base: null, origin: true, ahead: 1 });
    if (!early.push || !where) return early;
    const origin = await g.hasOrigin(where);
    if (!origin) return nodePushStep({ ...base, base: null, origin, ahead: 0 });
    const [defaultBranch, ahead] = await Promise.all([g.originDefault(where), g.ahead(where, early.branch)]);
    return nodePushStep({ ...base, base: defaultBranch, origin, ahead });
  }

  private async pushOnce(sessionId: string): Promise<void> {
    const session = (await this.deps.sessions()).find((s) => s.id === sessionId);
    if (!session) return;
    const step = await this.stepFor(session);
    if (!step.push) return;
    const answer = await (this.deps.git ?? realPushGit).push(session.worktreePath!, step.refspec);
    if (answer.ok) {
      if (this.failed.delete(sessionId)) this.changed();
      return;
    }
    const text = pushFailedText(step.branch, answer.said);
    this.deps.notice(sessionId, text, 'warning');
    this.failed.set(sessionId, { sessionId, title: session.title, key: `${sessionId}\n${(this.deps.now ?? Date.now)()}`, text });
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private log(text: string): void {
    (this.deps.log ?? ((t: string) => console.error(`[kestrel] push: ${t}`)))(text);
  }
}
