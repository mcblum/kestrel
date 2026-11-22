// Keep awake while agents work (0.0.20, matt/kestrel#24): an opt-in setting that stops this
// computer going to sleep from being idle while any session's agent is working, lets it sleep again when
// none is, and stands aside when the battery is low. Pure and browser-safe: the rule and the words;
// holding it awake is keep-awake/hold.ts (macOS and Linux; Windows cannot yet, and says so).

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

/** Why this computer cannot be held awake, when `why` is `unavailable`. */
export const UNAVAILABLE_ON_WINDOWS = 'Kestrel cannot keep a Windows computer awake yet. Change when it sleeps in Windows’ own Power settings.';
export const UNAVAILABLE_ON_LINUX = 'Keeping this computer awake needs systemd-inhibit, which was not found here.';

/** What the settings page says under the switch. `computer` is "this Mac" or "this computer"; `unavailable` is the server's reason. */
export function awakeText(state: AwakeState, power: Power, computer = 'this Mac', unavailable = 'Kestrel cannot keep this computer awake.'): string {
  if (state.holding) return `An agent is working: ${computer} is being kept awake.`;
  switch (state.why) {
    case 'off':
      return '';
    case 'idle':
      return `No agent is working, so ${computer} may sleep as usual.`;
    case 'low-battery':
      return `The battery is at ${power.percent}%, below ${LOW_BATTERY_PERCENT}%, so ${computer} is left to sleep.`;
    case 'unavailable':
      return unavailable;
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

/** A Linux battery, read from /sys/class/power_supply: its `status` ("Discharging", "Charging", "Full") and `capacity` (a percentage). */
export function parseLinuxPower(status: string | null, capacity: string | null): Power {
  const percent = capacity !== null && /^\d{1,3}$/.test(capacity.trim()) ? Math.min(100, Number(capacity.trim())) : null;
  return { onBattery: status !== null && status.trim().toLowerCase() === 'discharging', percent };
}

/** What the page is sent. */
export interface KeepAwakeView {
  enabled: boolean;
  state: AwakeState;
  power: Power;
  /** "this Mac" or "this computer" (shared/platform.ts). */
  computer?: string;
  /** Why this computer cannot be held awake; absent where it can. */
  unavailable?: string;
}
