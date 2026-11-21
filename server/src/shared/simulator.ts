// The simulator pane's shared vocabulary: devices as `simctl` lists them, what each can do,
// and how a point on the picture in the pane becomes a point on the device. Pure, so the UI and
// the server use the same rules and tests can pin them. See docs/designs/kestrel.md, "The
// simulator pane".
import type { Edge } from './sim-gestures.ts';
import type { KeyStep } from './sim-keys.ts';

export const NEEDS_MAC = 'The simulator pane needs macOS with Xcode.';
export const NO_SIMULATORS = 'No iOS simulators are installed. Add one in Xcode (Window > Devices and Simulators).';

export * from './sim-keys.ts';
export * from './sim-gestures.ts';

export type SimButton = 'home' | 'lock' | 'siri' | 'volume_up' | 'volume_down';
export const SIM_BUTTONS: readonly SimButton[] = ['home', 'lock', 'siri', 'volume_up', 'volume_down'];
export const BUTTON_LABEL: Record<SimButton, string> = { home: 'Home', lock: 'Lock', siri: 'Siri', volume_up: 'Volume up', volume_down: 'Volume down' };

/** What a device's input can do, from the helper (app/native/simhelper/Input.swift), with the reason for what it cannot. */
export interface SimCapabilities {
  /** "coredevice" (dtuhidd: everything), "legacy" (SimulatorKit: one finger and Home on iOS 26 and older) or "none". */
  input: 'coredevice' | 'legacy' | 'none';
  touch: boolean;
  multitouch: boolean;
  keyboard: boolean;
  buttons: SimButton[];
  rotate: boolean;
  shake: boolean;
  reasons: Partial<Record<SimAbility, string>>;
}
export type SimAbility = 'touch' | 'multitouch' | 'keyboard' | 'buttons' | 'rotate' | 'shake';

/** Nothing works, for this reason (no Mac, no helper, device not booted). */
export const noCapabilities = (reason: string): SimCapabilities => ({
  input: 'none',
  touch: false,
  multitouch: false,
  keyboard: false,
  buttons: [],
  rotate: false,
  shake: false,
  reasons: { touch: reason, multitouch: reason, keyboard: reason, buttons: reason, rotate: reason, shake: reason },
});

const UNSAID = 'The simulator helper did not say it can do this.';

/** The helper's ready line, read defensively: anything it does not claim is unavailable. */
export function parseCapabilities(ready: Record<string, unknown>): SimCapabilities {
  const c = (typeof ready.capabilities === 'object' && ready.capabilities !== null ? ready.capabilities : {}) as Record<string, unknown>;
  const said = (typeof ready.reasons === 'object' && ready.reasons !== null ? ready.reasons : {}) as Record<string, unknown>;
  const reasons: Partial<Record<SimAbility, string>> = {};
  const flag = (name: Exclude<SimAbility, 'buttons'>) => {
    if (c[name] === true) return true;
    reasons[name] = typeof said[name] === 'string' ? (said[name] as string) : UNSAID;
    return false;
  };
  const buttons = Array.isArray(c.buttons) ? SIM_BUTTONS.filter((b) => (c.buttons as unknown[]).includes(b)) : [];
  if (buttons.length < SIM_BUTTONS.length) reasons.buttons = typeof said.buttons === 'string' ? said.buttons : UNSAID;
  const input = ready.input === 'coredevice' || ready.input === 'legacy' ? ready.input : 'none';
  return { input, touch: flag('touch'), multitouch: flag('multitouch'), keyboard: flag('keyboard'), buttons, rotate: flag('rotate'), shake: flag('shake'), reasons };
}

/** Why the device cannot do this, or null when it can. */
export function cannot(caps: SimCapabilities, need: Exclude<SimAbility, 'buttons'> | { button: SimButton }): string | null {
  if (typeof need === 'object') return caps.buttons.includes(need.button) ? null : `${BUTTON_LABEL[need.button]} is not available on this simulator: ${caps.reasons.buttons ?? UNSAID}`;
  return caps[need] ? null : (caps.reasons[need] ?? UNSAID);
}

export type SimState ='Booted' | 'Shutdown' | 'Booting' | 'Shutting Down' | string;

export interface SimDevice {
  udid: string;
  name: string;
  /** "iOS 26.5". */
  os: string;
  state: SimState;
}

/** Device orientation as UIKit numbers it: 1 portrait, 2 upside down, 3 landscape left, 4 landscape right. */
export type Orientation = 1 | 2 | 3 | 4;

/** What the pane needs to draw a device and send it touches. */
export interface SimScreen {
  /** The portrait screen in points. */
  width: number;
  height: number;
  scale: number;
}

const OS_FROM_RUNTIME = /SimRuntime\.(iOS|tvOS|watchOS|xrOS|visionOS)-(\d+)(?:-(\d+))?(?:-(\d+))?$/;

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-5" -> "iOS 26.5"; null for runtimes the pane does not show. */
export function osOfRuntime(runtime: string): string | null {
  const m = OS_FROM_RUNTIME.exec(runtime);
  if (!m || m[1] !== 'iOS') return null;
  return `iOS ${[m[2], m[3], m[4]].filter((p) => p !== undefined).join('.')}`;
}

/**
 * The output of `xcrun simctl list devices available --json`, as iOS devices only: booted first,
 * then newest OS first, then by name. Anything malformed is skipped.
 */
export function parseDevices(json: unknown): SimDevice[] {
  const byRuntime = (json as { devices?: unknown } | null)?.devices;
  if (typeof byRuntime !== 'object' || byRuntime === null) return [];
  const found: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(byRuntime as Record<string, unknown>)) {
    const os = osOfRuntime(runtime);
    if (!os || !Array.isArray(list)) continue;
    for (const d of list as Record<string, unknown>[]) {
      if (typeof d?.udid !== 'string' || typeof d.name !== 'string' || typeof d.state !== 'string' || d.isAvailable === false) continue;
      found.push({ udid: d.udid, name: d.name, os, state: d.state });
    }
  }
  return found.sort(compareDevices);
}

function compareDevices(a: SimDevice, b: SimDevice): number {
  const booted = Number(b.state === 'Booted') - Number(a.state === 'Booted');
  if (booted) return booted;
  const os = b.os.localeCompare(a.os, undefined, { numeric: true });
  return os || a.name.localeCompare(b.name);
}

export const deviceLabel = (d: Pick<SimDevice, 'name' | 'os'>) => `${d.name} · ${d.os}`;

/** Turning the device a quarter turn: right is clockwise. */
export function rotate(from: Orientation, direction: 'left' | 'right'): Orientation {
  // Turned clockwise, the device's top goes right: UIKit calls that landscape right (4); landscape
  // left (3) has the top on the left.
  const clockwise: Orientation[] = [1, 4, 2, 3];
  const i = clockwise.indexOf(from);
  return clockwise[(i + (direction === 'right' ? 1 : 3)) % 4]!;
}

const DEVICECTL_ORIENTATION: Record<string, Orientation> = { portrait: 1, portraitUpsideDown: 2, landscapeLeft: 3, landscapeRight: 4 };

/**
 * The device's orientation from `devicectl device orientation get --json-output -`, or null when the
 * answer says nothing usable (face up or down counts as the last upright orientation it reports).
 */
export function orientationFromDevicectl(json: unknown): Orientation | null {
  const result = (json as { result?: Record<string, unknown> } | null)?.result;
  if (typeof result !== 'object' || result === null) return null;
  for (const key of ['deviceOrientationNonFlat', 'deviceOrientation']) {
    const name = result[key];
    if (typeof name === 'string' && DEVICECTL_ORIENTATION[name]) return DEVICECTL_ORIENTATION[name];
  }
  return null;
}

/** The size of the picture as shown: portrait sizes swap in landscape. */
export function shownSize(screen: Pick<SimScreen, 'width' | 'height'>, orientation: Orientation): { width: number; height: number } {
  return orientation === 3 || orientation === 4 ? { width: screen.height, height: screen.width } : { width: screen.width, height: screen.height };
}

/**
 * A point on the picture as the user sees it, in its own (upright) points, to the device's portrait
 * points, which is what the touch helper takes. Checked on a device: in landscape left (3) the
 * device's top is at the picture's left.
 */
export function toDevicePoint(x: number, y: number, screen: Pick<SimScreen, 'width' | 'height'>, orientation: Orientation): { x: number; y: number } {
  const { width: W, height: H } = screen;
  switch (orientation) {
    case 2:
      return { x: W - x, y: H - y };
    case 3:
      return { x: W - y, y: x };
    case 4:
      return { x: y, y: H - x };
    default:
      return { x, y };
  }
}

/**
 * Where a pointer is on the device, from its position inside the picture's box on the page.
 * `box` is the picture's drawn size in CSS pixels. Null outside the picture.
 */
export function pointerToDevice(offsetX: number, offsetY: number, box: { width: number; height: number }, screen: Pick<SimScreen, 'width' | 'height'>, orientation: Orientation): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0) return null;
  if (offsetX < 0 || offsetY < 0 || offsetX > box.width || offsetY > box.height) return null;
  const shown = shownSize(screen, orientation);
  const p = toDevicePoint((offsetX / box.width) * shown.width, (offsetY / box.height) * shown.height, screen, orientation);
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}

/** Messages over the WebSocket. Frames go the other way as binary: [1 byte 0x53][36-byte udid][JPEG]. */
export const FRAME_MARK = 0x53;
export const UDID_LENGTH = 36;
export type SimSocketMessage =
  | { type: 'sim-watch'; udid: string; maxWidth: number }
  | { type: 'sim-unwatch'; udid: string }
  /** A finger (two with x2, y2: the pane's Option-drag) in device portrait points; `edge` when it starts at the border. */
  | { type: 'sim-touch'; udid: string; phase: 'down' | 'move' | 'up'; x: number; y: number; x2?: number; y2?: number; edge?: Edge }
  /** Keys the user pressed with the picture focused (see keyForDevice). */
  | { type: 'sim-keys'; udid: string; steps: KeyStep[] }
  /** Server -> windows: a tool used the simulator for this session; show it the device. */
  | { type: 'sim-show'; sessionId: string; udid: string }
  /** Server -> windows: a device's state or orientation changed. */
  | { type: 'sim-changed'; udid: string };

export const isUdid = (value: unknown): value is string => typeof value === 'string' && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
