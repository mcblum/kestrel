// Where Settings → Workflow → "Commands kept per session" is kept (shared/commands.ts): one small
// named setting in the store, so both persistence backends keep it. The number is also held in
// memory, because the command store trims a list on every agent event and must not wait for the
// database (runtime/commands.ts). Writes run one after another.
import { commandsKeptProblem, DEFAULT_COMMANDS_KEPT } from '../shared/commands.ts';
import { Refused } from '../refused.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const COMMANDS_KEPT_KEY = 'commands-kept';

export interface CommandsKeptView {
  kept: number;
  defaultKept: number;
}

export class CommandsKept {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private held = DEFAULT_COMMANDS_KEPT;
  /** Resolves once the stored number has been read; the default until then. */
  readonly loaded: Promise<void>;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
    this.loaded = this.read().then((kept) => void (this.held = kept));
  }

  /** The number in force now: 0 keeps every command. */
  current(): number {
    return this.held;
  }

  async view(): Promise<CommandsKeptView> {
    await this.loaded;
    return { kept: this.held, defaultKept: DEFAULT_COMMANDS_KEPT };
  }

  /** Stores `kept`; refused with the reason when it is not a whole number in range. */
  set(kept: unknown): Promise<CommandsKeptView> {
    const problem = commandsKeptProblem(kept);
    if (problem) return Promise.reject(new Refused(problem));
    const work = this.writes.then(async () => {
      await this.loaded;
      await this.store.putSetting(COMMANDS_KEPT_KEY, JSON.stringify(kept));
      this.held = kept as number;
      return { kept: this.held, defaultKept: DEFAULT_COMMANDS_KEPT };
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  private async read(): Promise<number> {
    try {
      const raw = await this.store.getSetting(COMMANDS_KEPT_KEY);
      const value: unknown = raw === null ? DEFAULT_COMMANDS_KEPT : JSON.parse(raw);
      return commandsKeptProblem(value) === null ? (value as number) : DEFAULT_COMMANDS_KEPT;
    } catch {
      return DEFAULT_COMMANDS_KEPT; // unreadable: the default, and the next write replaces it
    }
  }
}
