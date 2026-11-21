// Keep awake while agents work (0.0.20, matt/kestrel#24): an opt-in setting that stops this Mac
// going to sleep from being idle while any session's agent is working, lets it sleep again when
// none is, and stands aside when the battery is low. Pure and browser-safe: the rule and the words;
// holding the Mac awake is keep-awake/hold.ts.

export interface KeepAwakePrefs {
  /** Off unless the user turns it on. */
  enabled: boolean;
}

export const DEFAULT_KEEP_AWAKE: KeepAwakePrefs = { enabled: false };

/** On battery below this, the Mac is left to sleep: finishing the work is not worth a dead battery. */
export const LOW_BATTERY_PERCENT = 20;

/** What the Mac runs on now. `percent` is null when there is no battery or it cannot be read. */
export interface Power {
  onBattery: boolean;
  percent: number | null;
}

export const ON_MAINS: Power = { onBattery: false, percent: null };

/** Whether the Mac is being held awake, and when not, why. */
export type AwakeState = { holding: true } | { holding: false; why: 'off' | 'idle' | 'low-battery' | 'unavailable' };

/** The rule: on, something working, and not on a low battery. */
export function awakeState(prefs: KeepAwakePrefs, working: boolean, power: Power, available = true): AwakeState {
  if (!prefs.enabled) return { holding: false, why: 'off' };
  if (!available) return { holding: false, why: 'unavailable' };
  if (!working) return { holding: false, why: 'idle' };
  if (power.onBattery && power.percent !== null && power.percent < LOW_BATTERY_PERCENT) return { holding: false, why: 'low-battery' };
  return { holding: true };
}

/** What the settings page says under the switch. */
export function awakeText(state: AwakeState, power: Power): string {
  if (state.holding) return 'An agent is working: this Mac is being kept awake.';
  switch (state.why) {
    case 'off':
      return '';
    case 'idle':
      return 'No agent is working, so this Mac may sleep as usual.';
    case 'low-battery':
      return `The battery is at ${power.percent}%, below ${LOW_BATTERY_PERCENT}%, so this Mac is left to sleep.`;
    case 'unavailable':
      return 'Kestrel can only keep a Mac awake.';
  }
}

export function sanitizeKeepAwake(value: unknown): KeepAwakePrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { enabled: v.enabled === true };
}

/** `pmset -g batt`, read: "Now drawing from 'Battery Power'" and "…\t34%; discharging; …". Mains when it says nothing of the kind. */
export function parsePower(report: string): Power {
  const onBattery = /drawing from 'Battery Power'/.test(report);
  const percent = /(\d{1,3})%/.exec(report);
  return { onBattery, percent: percent ? Math.min(100, Number(percent[1])) : null };
}

/** What the page is sent. */
export interface KeepAwakeView {
  enabled: boolean;
  state: AwakeState;
  power: Power;
}
