// Holds this Mac awake while agents work (shared/keep-awake.ts): `caffeinate -i -w <Kestrel's pid>`,
// which stops idle sleep only (the display may still sleep, and closing the lid still sleeps it)
// and ends by itself if Kestrel dies. Started when the rule says hold and ended when it does not;
// the rule is asked again whenever the workspace changes, and once a minute while holding, for the
// battery. One small stored setting, off by default.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { awakeState, DEFAULT_KEEP_AWAKE, ON_MAINS, parsePower, sanitizeKeepAwake, type AwakeState, type KeepAwakePrefs, type KeepAwakeView, type Power } from '../shared/keep-awake.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const KEEP_AWAKE_KEY = 'keep-awake';
const RECHECK_MS = 60_000;

/** Something that holds the Mac awake until it is released. */
export type Hold = { release(): void };

export interface KeepAwakeOptions {
  settings?: SettingStore;
  /** Whether any session's agent is working now. */
  working: () => Promise<boolean>;
  /** Starts holding the Mac awake; tests pass their own. */
  hold?: () => Hold;
  /** What the Mac runs on; tests pass their own. */
  power?: () => Promise<Power>;
  /** Whether this computer can be held awake at all (a Mac); tests pass true. */
  available?: boolean;
  recheckMs?: number;
}

const caffeinate = (): Hold => {
  const child: ChildProcess = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => undefined); // not there: the Mac simply sleeps as usual
  return { release: () => void child.kill() };
};

const pmset = (): Promise<Power> => new Promise((resolve) => execFile('pmset', ['-g', 'batt'], { timeout: 3000 }, (error, stdout) => resolve(error ? ON_MAINS : parsePower(stdout))));

export class KeepAwake {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private held: Hold | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<KeepAwakeView> | null = null;
  private readonly available: boolean;

  constructor(private readonly opts: KeepAwakeOptions) {
    this.store = opts.settings ?? memorySettings();
    this.available = opts.available ?? process.platform === 'darwin';
  }

  /** Read from the store once and kept: the rule is asked on every change of the workspace. */
  private known: Promise<KeepAwakePrefs> | null = null;

  prefs(): Promise<KeepAwakePrefs> {
    this.known ??= this.store.getSetting(KEEP_AWAKE_KEY).then(
      (raw) => {
        try {
          return raw ? sanitizeKeepAwake(JSON.parse(raw)) : DEFAULT_KEEP_AWAKE;
        } catch {
          return DEFAULT_KEEP_AWAKE;
        }
      },
      () => DEFAULT_KEEP_AWAKE,
    );
    return this.known;
  }

  async set(enabled: boolean): Promise<KeepAwakeView> {
    const work = this.writes.then(() => this.store.putSetting(KEEP_AWAKE_KEY, JSON.stringify({ enabled })));
    this.writes = work.catch(() => undefined);
    await work;
    this.known = Promise.resolve({ enabled });
    // A check already running read the old value: wait for it, then ask again.
    await this.checking?.catch(() => undefined);
    return this.refresh();
  }

  /** Ask the rule again and hold or release to match. Calls made while one is running share its answer. */
  refresh(): Promise<KeepAwakeView> {
    this.checking ??= this.check().finally(() => (this.checking = null));
    return this.checking;
  }

  private async check(): Promise<KeepAwakeView> {
    const prefs = await this.prefs();
    // The battery is only read when it could matter: the setting is on and something is working.
    const working = prefs.enabled && this.available ? await this.opts.working() : false;
    const power = working ? await (this.opts.power ?? pmset)() : ON_MAINS;
    const state: AwakeState = awakeState(prefs, working, power, this.available);
    if (state.holding && !this.held) this.held = (this.opts.hold ?? caffeinate)();
    if (!state.holding && this.held) {
      this.held.release();
      this.held = null;
    }
    // While holding, the battery is looked at again each minute; otherwise only a change of the workspace asks.
    if (state.holding && !this.timer) {
      this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.opts.recheckMs ?? RECHECK_MS);
      this.timer.unref?.();
    }
    if (!state.holding && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return { enabled: prefs.enabled, state, power };
  }

  /** Kestrel is shutting down: let the Mac sleep. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.held?.release();
    this.held = null;
  }
}
