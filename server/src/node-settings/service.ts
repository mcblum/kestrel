// A worker node's settings as another computer changes them, and its Restart (docs/designs/worker-nodes.md, section
// 10, "The closed list"). Only a node has one (start-server.ts). Each key of `NODE_SETTINGS` (shared/node-settings.ts)
// is carried out by the setting's own function, the same one the setting's own screen or the node's terminal uses:
// nothing here keeps a value of its own.
//
// - name: Kestrel Connect's name for this computer (`setComputerName`).
// - remoteStarts: "Other devices may start sessions on this computer" (remote-starts/prefs.ts).
// - agent, model, mode: what the New session box starts with, the remembered choices in the UI state
//   (shared/sticky-controls.ts, through `withNodeStart`).
// - autoReviews: Settings → Code reviews' mode (review-settings/prefs.ts, through `reviewModeFor`).
// - projects, push: the node's Projects settings (project-clone/prefs.ts).
// - followDesktopVersion: "Keep this node on my desktops' version" (node-update/store.ts), then the updater looks again.
//
// What it publishes (`published`) is what the node's offers record carries for its page: the settings, read back from
// those stores, and the status facts (shared/node-facts.ts). `onChange` tells the offers sync when either may differ.
import type { ModelOption } from '../agents/types.ts';
import type { Agent } from '../model.ts';
import { Refused } from '../refused.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import type { NodeFacts, NodePublished } from '../shared/node-facts.ts';
import { autoReviewsOf, nodeSettingRefusal, nodeStartModeOf, notANode, restartBusy, restartingText, restartNoService, reviewModeFor, withNodeStart, type NodeHas, type NodeRestartAnswer, type NodeSettingKey, type NodeSettingsValues, type NodeStartChange } from '../shared/node-settings.ts';
import type { NodeProjectPrefs } from '../shared/node-push.ts';
import type { ReviewSettings } from '../shared/review-settings.ts';
import { storedRemembered } from '../shared/sticky-controls.ts';
import { deskStart } from '../remote-starts/session-start.ts';

/** How long a restart waits after it was asked, so its answer reaches the computer that asked first. */
export const RESTART_AFTER_MS = 500;

type Listen = (listener: () => void) => () => void;

export interface NodeSettingsDeps {
  kind: KestrelKind;
  /** This node, as other devices call it. */
  name(): string;
  /** Kestrel Connect's name for this computer (`KestrelConnect.setComputerName`). */
  rename(name: string): Promise<unknown>;
  remoteStarts: { prefs(): Promise<{ allowed: boolean }>; setAllowed(allowed: boolean): Promise<unknown>; onChange: Listen };
  /** The stored UI state, where the New session box's choices are remembered. */
  uiState: { get(): Promise<string | null>; set(raw: string): Promise<void> };
  reviews: { current(): Promise<ReviewSettings>; set(change: Partial<ReviewSettings>): Promise<unknown>; onChange(listener: (s: ReviewSettings) => void): () => void };
  projects: { current(): Promise<NodeProjectPrefs>; set(change: Partial<NodeProjectPrefs>): Promise<unknown>; onChange: Listen };
  /** "Keep this node on my desktops' version"; `set` also has the updater look again. */
  follow: { current(): Promise<boolean>; set(on: boolean): Promise<unknown> };
  /** The agents Kestrel runs here, and each one's models (an agent that cannot list them answers none). */
  agents(): readonly Agent[];
  models(agent: Agent): Promise<readonly ModelOption[]>;
  /** The status facts, from what `kestrel node status` prints. */
  facts(): Promise<NodeFacts>;
  /** The titles of the sessions with a turn running now. */
  running(): Promise<readonly string[]>;
  /** Whether systemd runs this node (its unit is there and this process is its main one), the only way it starts again. */
  service(): Promise<boolean>;
  /** Restarts the node's unit; this process ends with it. */
  restartUnit(): void;
  /** Other things that change what is published (an agent's answer, a clone ending). Each returns its undo. */
  watch?: readonly Listen[];
  /** For tests: the restart's wait. */
  later?(work: () => void, ms: number): void;
}

/** What the dispatcher and the offers record read of a node's settings. */
export type NodeSettingsOps = Pick<NodeSettings, 'published' | 'set' | 'restart' | 'onChange'>;

export class NodeSettings {
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[];
  private restarting = false;

  constructor(private readonly deps: NodeSettingsDeps) {
    const told = () => this.changed();
    this.offs = [deps.remoteStarts.onChange(told), deps.reviews.onChange(told), deps.projects.onChange(told), ...(deps.watch ?? []).map((listen) => listen(told))];
  }

  /** Told when a setting or a fact may have changed. Returns the undo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** A setting changed by another way than `set` (its name, renamed from another device's Devices list): publish again. */
  changedElsewhere(): void {
    this.changed();
  }

  close(): void {
    this.offs.forEach((off) => off());
    this.listeners.clear();
  }

  /** The settings as their own stores have them now. */
  async values(): Promise<NodeSettingsValues> {
    const [starts, raw, reviews, projects, follow] = await Promise.all([this.deps.remoteStarts.prefs(), this.deps.uiState.get(), this.deps.reviews.current(), this.deps.projects.current(), this.deps.follow.current()]);
    const start = deskStart(raw);
    return { name: this.deps.name(), remoteStarts: starts.allowed, agent: start.agent, model: start.model, mode: nodeStartModeOf(start.permission), autoReviews: autoReviewsOf(reviews.mode), projects: projects.projects, push: projects.push, followDesktopVersion: follow };
  }

  /** What the node's offers record carries for its page. */
  async published(): Promise<NodePublished> {
    const [settings, facts] = await Promise.all([this.values(), this.deps.facts()]);
    return { settings, facts };
  }

  /**
   * One setting, from another computer's page: checked against the closed list and against what this node has,
   * then carried out by the setting's own function. Answers what is published now; a refusal throws `Refused`.
   */
  async set(key: NodeSettingKey, value: unknown): Promise<NodePublished> {
    if (this.deps.kind !== 'node') throw new Refused(notANode(this.deps.name()));
    const refusal = nodeSettingRefusal(key, value, await this.has(key, value));
    if (refusal) throw new Refused(refusal);
    await this.carryOut(key, value);
    this.changed();
    return this.published();
  }

  /** Restart, from another computer: refused while a turn runs (naming the sessions) or where systemd would not start it again. */
  async restart(): Promise<NodeRestartAnswer> {
    const here = this.deps.name();
    if (this.deps.kind !== 'node') throw new Refused(notANode(here));
    const running = await this.deps.running();
    if (running.length > 0) throw new Refused(restartBusy(here, running));
    if (!(await this.deps.service())) throw new Refused(restartNoService(here));
    if (!this.restarting) {
      this.restarting = true;
      (this.deps.later ?? ((work, ms) => void setTimeout(work, ms)))(() => this.deps.restartUnit(), RESTART_AFTER_MS);
    }
    return { text: restartingText(here) };
  }

  /** What only this node can check: its agents, and the models of the agent a model is for. */
  private async has(key: NodeSettingKey, value: unknown): Promise<NodeHas | undefined> {
    if (key !== 'agent' && key !== 'model') return undefined;
    const agent = deskStart(await this.deps.uiState.get()).agent;
    const models = key === 'model' && value !== '' ? (await this.deps.models(agent)).map((m) => m.id) : [];
    return { here: this.deps.name(), agents: this.deps.agents(), agent, models: (a) => (a === agent && models.length > 0 ? models : null) };
  }

  private async carryOut(key: NodeSettingKey, value: unknown): Promise<void> {
    switch (key) {
      case 'name':
        return void (await this.deps.rename(value as string));
      case 'remoteStarts':
        return void (await this.deps.remoteStarts.setAllowed(value as boolean));
      case 'agent':
      case 'model':
      case 'mode':
        return this.setStart({ key, value } as NodeStartChange);
      case 'autoReviews': {
        const now = (await this.deps.reviews.current()).mode;
        const mode = reviewModeFor(value as boolean, now);
        return void (mode !== now && (await this.deps.reviews.set({ mode })));
      }
      case 'projects':
        return void (await this.deps.projects.set({ projects: value as NodeProjectPrefs['projects'] }));
      case 'push':
        return void (await this.deps.projects.set({ push: value as boolean }));
      case 'followDesktopVersion':
        return void (await this.deps.follow.set(value as boolean));
    }
  }

  /** The New session box's remembered choices, changed as its own Settings changes them; the rest of the UI state kept. */
  private async setStart(change: NodeStartChange): Promise<void> {
    const raw = await this.deps.uiState.get();
    const stored = parsed(raw);
    const before = storedRemembered(stored);
    const models = change.key === 'model' ? await this.deps.models(deskStart(raw).agent) : [];
    await this.deps.uiState.set(JSON.stringify({ ...stored, remembered: withNodeStart(before, change, models) }));
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

function parsed(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {}; // unreadable: written again whole, as the window's own write would
  }
}
