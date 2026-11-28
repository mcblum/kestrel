// A worker node follows the account's desktops (worker-nodes.md 4.2). `nodeUpdateStep` (shared/node-update.ts)
// decides from plain facts; this reads them and carries the step out. Only a node has one (start-server.ts).
//
// It looks again only when something it depends on changed, never on a timer: a desktop's offers record changed in
// the change feed, a desktop contacted the node (Kestrel Connect's view changed: a channel opened, the devices were
// read), and, while it waits, the node may have become idle (a session's state changed, a clone or a push ended). Idle
// is no turn running, no clone and no push under way, and no session waiting on a card a restart would lose: the
// sessions the quit check names (shared/quit-check.ts), by the same rule.
//
// Updating is the bundle's install script run for exactly the target version by a runner apart from the node's unit
// (runner.ts). From the moment it starts until the new version answers, a start is refused (`updatingRefusal`). What
// an update left (runner.ts's outcome) is read at start and when the runner ends: a failure is remembered through
// the Persistence facade (store.ts) and that version is not tried again until Update now.
import type { KestrelKind } from '../shared/host-kind.ts';
import { isVersion, newestVersion, nodeUpdateLine, nodeUpdateStep, noteOfStep, NOT_BUSY, updatingRefusal, type NodeBusy, type NodeUpdateNote, type NodeUpdateStep, type UpdateNowAnswer } from '../shared/node-update.ts';
import type { UpdateOutcome } from './runner.ts';
import type { NodeUpdateStore } from './store.ts';

export interface NodeUpdaterDeps {
  kind: KestrelKind;
  /** This node's version. */
  version: string;
  /** This node, as other devices call it. */
  name(): string;
  store: Pick<NodeUpdateStore, 'current' | 'set'>;
  /** The version each desktop of the account runs, from its offers record; null where it says none. Never a phone or a node. */
  desktops(): Promise<readonly (string | null)[]>;
  /** What holds an update back now. */
  busy(): Promise<NodeBusy>;
  /** Whether it runs under its systemd unit, the only way an update restarts it. */
  service(): Promise<boolean>;
  /** Starts the update to `target`; resolves when the runner has ended (when it restarted the node, the node ends first). */
  run(target: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** What an update left: read and removed; null when there is nothing. */
  takeOutcome(): UpdateOutcome | null;
  log?(text: string): void;
}

/** What the dispatcher, the offers record and `status` read of the updater. */
export type NodeUpdateOps = Pick<NodeUpdater, 'note' | 'refusal' | 'updateNow' | 'line' | 'onChange'>;

export class NodeUpdater {
  private step: NodeUpdateStep = { do: 'stay', why: 'current' };
  private updating: string | null = null;
  /** Update now was asked and has not run yet. */
  private asked = false;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: NodeUpdaterDeps) {}

  /** What the node's offers record says of an update, or null. */
  note(): NodeUpdateNote | null {
    return this.deps.kind === 'node' ? noteOfStep(this.updating ? { do: 'stay', why: 'updating', to: this.updating } : this.step) : null;
  }

  /** `kestrel node status`'s update line, from the same note. */
  line(): string | null {
    return nodeUpdateLine(this.deps.name(), isVersion(this.deps.version) ? this.deps.version : null, this.note());
  }

  /** Why a session may not start here now, or null. */
  refusal(): string | null {
    return this.updating ? updatingRefusal(this.deps.name(), this.updating) : null;
  }

  /** Told when the note changes. Returns the undo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Something a step depends on changed: look again. One look at a time; one asked for during one runs after it. */
  check(): Promise<void> {
    if (this.closed || this.deps.kind !== 'node') return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass().catch((error: unknown) => this.log(`could not check for an update: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again && !this.closed);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Something that may have made the node idle: looked at only while it waits for its work. */
  maybeIdle(): void {
    if (this.step.do === 'wait') void this.check();
  }

  /** Update now (`node.update`): the same step, waiting only for running turns, and trying a failed version again. */
  async updateNow(): Promise<UpdateNowAnswer> {
    if (this.deps.kind !== 'node') return { to: null, started: false, waitingFor: [], text: `${this.deps.name()} is not a worker node.` };
    if (this.updating) return { to: this.updating, started: true, waitingFor: [], text: this.line() ?? '' };
    this.asked = true;
    // A look already under way runs once more after itself, so this one sees the ask.
    await this.check();
    const step = this.step;
    if (this.updating) return { to: this.updating, started: true, waitingFor: [], text: this.line() ?? '' };
    if (step.do === 'wait') return { to: step.to, started: false, waitingFor: [...step.busy.sessions], text: this.line() ?? '' };
    return { to: null, started: false, waitingFor: [], text: this.line() ?? `${this.deps.name()} is on the newest version your desktops run.` };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private async pass(): Promise<void> {
    await this.takeOutcome();
    const prefs = await this.deps.store.current();
    const base = { kind: this.deps.kind, version: this.deps.version, desktops: await this.deps.desktops(), on: prefs.follow, asked: this.asked, failed: prefs.failed, updating: this.updating };
    // The work and the service are asked only when the rest would move it.
    let step = nodeUpdateStep({ ...base, busy: NOT_BUSY, service: true });
    if (step.do === 'update') step = nodeUpdateStep({ ...base, busy: await this.deps.busy(), service: await this.deps.service() });
    if (step.do === 'stay' && step.why !== 'updating' && step.why !== 'off' && step.why !== 'no-service') this.asked = false;
    this.setStep(step);
    if (step.do === 'update') this.start(step.to);
  }

  /** Reads what an update left, and remembers a failure; a version that arrived clears one. */
  private async takeOutcome(): Promise<void> {
    const outcome = this.deps.takeOutcome();
    if (!outcome) return;
    if (!outcome.ok) {
      this.log(`the update to ${outcome.target} did not arrive: ${outcome.failed.reason}`);
      await this.deps.store.set({ failed: outcome.failed });
      return;
    }
    const { failed } = await this.deps.store.current();
    if (failed && newestVersion([failed.version, this.deps.version]) === this.deps.version) await this.deps.store.set({ failed: null });
  }

  private start(to: string): void {
    this.updating = to;
    this.asked = false;
    this.changed();
    this.log(`updating to ${to}, the version your desktops run`);
    void this.deps
      .run(to)
      .then(async (result) => {
        // Still running: the runner ended without the node being restarted (it failed before anything moved, or could not start).
        if (!result.ok) await this.deps.store.set({ failed: { version: to, reason: result.reason } });
      })
      .catch(async (error: unknown) => this.deps.store.set({ failed: { version: to, reason: error instanceof Error ? error.message : String(error) } }))
      .finally(() => {
        this.updating = null;
        this.changed();
        void this.check();
      });
  }

  private setStep(step: NodeUpdateStep): void {
    const before = JSON.stringify(this.note());
    this.step = step;
    if (JSON.stringify(this.note()) !== before) this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private log(text: string): void {
    (this.deps.log ?? ((t: string) => console.error(`[kestrel] node update: ${t}`)))(text);
  }
}
