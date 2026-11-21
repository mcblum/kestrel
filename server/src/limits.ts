// Delegation limits (design doc, "Delegate up"): a setting the user changes in Settings → Workflow
// (Matt, 2026-11-19), with the defaults and ranges in shared/delegation-limits.ts. Every check
// against them lives in workspace-records.ts and refuses with the messages below, which are written
// for an agent to read and always state the number in force.
//
// Kept as one small named setting in the store, so every persistence provider keeps it (shaped like
// project-edits/prefs.ts). Writes run one after another. The values are held in memory once read:
// they are asked for at every delegate, handoff and spawn, and only this class writes them.
import { checkLimits, DEFAULT_LIMITS, sanitizeLimits, type DelegationLimits, type DelegationLimitsView } from './shared/delegation-limits.ts';
import { Refused } from './refused.ts';
import { memorySettings, type SettingStore } from './suggestions/prefs.ts';

export { DEFAULT_LIMITS, type DelegationLimits };

export const DELEGATION_LIMITS_KEY = 'delegation-limits';

export const limitMessage = {
  tooManyTasks: (limits: DelegationLimits, got: number) => `delegate takes at most ${limits.maxChildrenPerDelegate} tasks; got ${got}. Split the work into fewer, larger tasks.`,
  noTasks: () => 'delegate needs at least one task: { project, brief }.',
  tooDeep: (limits: DelegationLimits) => `A session tree can be at most ${limits.maxDepth} level${limits.maxDepth === 1 ? '' : 's'} deep below its first session. Do this work yourself instead of delegating further.`,
  tooManyLive: (limits: DelegationLimits, live: number) => `A session tree can have at most ${limits.maxLiveSessionsPerTree} live sessions; this one has ${live}. Wait for some to finish.`,
} as const;

export class DelegationLimitsPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private held: DelegationLimits | null = null;
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  /** The limits in force: the stored ones, each made safe, or the defaults when none are stored. Read once. */
  async current(): Promise<DelegationLimits> {
    if (this.held) return this.held;
    const raw = await this.store.getSetting(DELEGATION_LIMITS_KEY);
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null; // unreadable: the defaults, and the next write replaces it
    }
    this.held = sanitizeLimits(parsed);
    return this.held;
  }

  async view(): Promise<DelegationLimitsView> {
    return { limits: await this.current(), defaults: DEFAULT_LIMITS };
  }

  /** Save new limits; refused, with the reason, when one is not a whole number in its range. */
  set(raw: unknown): Promise<DelegationLimitsView> {
    const work = this.writes.then(async () => {
      const checked = checkLimits(raw);
      if (!checked.ok) throw new Refused(checked.reason);
      await this.store.putSetting(DELEGATION_LIMITS_KEY, JSON.stringify(checked.limits));
      this.held = checked.limits;
      return { limits: checked.limits, defaults: DEFAULT_LIMITS };
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  /** Back to the defaults: nothing is kept, so a later change of default reaches this user too. */
  reset(): Promise<DelegationLimitsView> {
    const work = this.writes.then(async () => {
      await this.store.putSetting(DELEGATION_LIMITS_KEY, JSON.stringify({}));
      this.held = DEFAULT_LIMITS;
      return { limits: DEFAULT_LIMITS, defaults: DEFAULT_LIMITS };
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
