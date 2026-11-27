// The agent's side of the simulator pane: tools that run, look at and operate an iOS app in the
// simulator. Unlike the browser, the server drives the simulator itself, so these work with the
// session in the background; a window showing the session is only told to bring up the Simulator
// view on that device. Coordinates are device points on the screen as it is shown (upright), and
// are turned into the device's own frame here (shared/sim-gestures.ts).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { KestrelToolHost, ToolResult } from './agents/types.ts';
import { OutsideFolder, resolveInside } from './files.ts';
import type { InputOutcome, InputRequest } from './sim-input.ts';
import type { SettleOutcome } from './sim-settle.ts';
import { isAppBundle, type Simulator } from './simulator.ts';
import {
  BUTTON_LABEL,
  deviceLabel,
  LONG_PRESS_MS,
  MODIFIERS,
  namedKey,
  PINCH_LIMITS,
  pinchGesture,
  shownSize,
  SIM_BUTTONS,
  swipeGesture,
  tapGesture,
  textToKeys,
  type Modifier,
  type Orientation,
  type Point,
  type SimAbility,
  type SimButton,
  type SimDevice,
} from './shared/simulator.ts';
import { Refused } from './workspace.ts';

export type SimToolHost = Pick<
  KestrelToolHost,
  'simList' | 'simBoot' | 'simLaunch' | 'simScreenshot' | 'simTap' | 'simSwipe' | 'simPinch' | 'simType' | 'simKey' | 'simButton' | 'simOpenUrl' | 'simAppearance'
>;

/** What the simulator tools need from the runtime. */
export interface SimHost {
  directoryOf(sessionId: string): Promise<string | null>;
  notice(sessionId: string, text: string, level: 'error'): void;
  /** Tell windows showing the session to bring up the Simulator view on this device. */
  show(sessionId: string, udid: string): void;
}

const ORIENTATION_NAME: Record<Orientation, string> = { 1: 'portrait', 2: 'portrait upside down', 3: 'landscape (top to the left)', 4: 'landscape (top to the right)' };
const MAX_SWIPE_MS = 5_000;
const MAX_HOLD_MS = 10_000;
const MAX_TEXT = 2_000;
/** Between typed characters, so a busy text field keeps up. */
const KEY_GAP_MS = 8;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
export const DERIVED_DATA = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
const SHAKE = 'shake';

const SETTLED: Record<SettleOutcome, string> = {
  ready: 'It has drawn its first screen.',
  blank: 'Its screen still looked blank after 10 seconds: take a screenshot to check, it may still be starting.',
  changing: 'Its screen was still changing after 10 seconds: take a screenshot to see where it is.',
  'no-picture': 'Kestrel could not watch the screen to see it draw: take a screenshot to check.',
};

export class SimTools {
  /** The device each scope works with: the one its session booted, or the one the user picked in its pane. Keyed by scope key (a session's is its bare id). */
  private readonly chosen = new Map<string, string>();

  constructor(
    readonly simulator: Simulator,
    private readonly host: SimHost,
    private readonly derivedData: string = DERIVED_DATA,
    /** Why the simulator cannot be used on this computer (it has no screen), or null. Every tool is refused with it. */
    private readonly noScreen: string | null = null,
  ) {}

  /** The user picked a device in a pane: a session's agent uses it from now on. A project or group page's pick is only remembered for its pane. */
  choose(scopeKey: string, udid: string): void {
    this.chosen.set(scopeKey, udid);
  }

  hostFor(sessionId: string): SimToolHost {
    const g = (tool: string, work: () => Promise<ToolResult>) => this.guard(sessionId, tool, work);
    return {
      simList: () => g('sim_list', () => this.list()),
      simBoot: (a) => g('sim_boot', () => this.boot(sessionId, a)),
      simLaunch: (a) => g('sim_launch', () => this.launch(sessionId, a)),
      simScreenshot: () => g('sim_screenshot', () => this.screenshot(sessionId)),
      simTap: (a) => g('sim_tap', () => this.tap(sessionId, a)),
      simSwipe: (a) => g('sim_swipe', () => this.swipe(sessionId, a)),
      simPinch: (a) => g('sim_pinch', () => this.pinch(sessionId, a)),
      simType: (a) => g('sim_type', () => this.type(sessionId, a)),
      simKey: (a) => g('sim_key', () => this.key(sessionId, a)),
      simButton: (a) => g('sim_button', () => this.button(sessionId, a)),
      simOpenUrl: (a) => g('sim_open_url', () => this.openUrl(sessionId, a)),
      simAppearance: (a) => g('sim_appearance', () => this.appearance(sessionId, a)),
    };
  }

  /** A refusal goes back to the agent and shows in the conversation, like Kestrel's other tools. */
  private async guard(sessionId: string, tool: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      if (this.noScreen) throw new Refused(this.noScreen);
      return await work();
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      this.host.notice(sessionId, `Kestrel refused ${tool}: ${error.message}`, 'error');
      return { text: error.message, isError: true };
    }
  }

  /** The session's booted device, and the Simulator view brought up on it. */
  private async device(sessionId: string): Promise<SimDevice> {
    const booted = await this.simulator.booted();
    const chosen = this.chosen.get(sessionId);
    const device = booted.find((d) => d.udid === chosen) ?? booted[0];
    if (!device) throw new Refused('No simulator is booted. Call sim_boot with a device from sim_list first.');
    this.chosen.set(sessionId, device.udid);
    this.host.show(sessionId, device.udid);
    return device;
  }

  private async list(): Promise<ToolResult> {
    const devices = await this.simulator.devices();
    if (!devices.length) return { text: 'No iOS simulators are installed.' };
    const lines = devices.map((d) => `${d.name} | ${d.os} | ${d.udid} | ${d.state}`);
    return { text: `iOS simulators (name | OS | udid | state), booted first:\n${lines.join('\n')}` };
  }

  private async boot(sessionId: string, args: { device?: unknown }): Promise<ToolResult> {
    const given = typeof args.device === 'string' ? args.device : '';
    const found = await this.simulator.find(given);
    this.chosen.set(sessionId, found.udid);
    this.host.show(sessionId, found.udid);
    const device = await this.simulator.boot(found.udid);
    return { text: `${deviceLabel(device)} is booted (udid ${device.udid}). The user sees it in the Simulator view.` };
  }

  private async launch(sessionId: string, args: { app_path?: unknown; bundle_id?: unknown }): Promise<ToolResult> {
    const appPath = typeof args.app_path === 'string' ? args.app_path.trim() : '';
    const bundle = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : '';
    if (!appPath === !bundle) throw new Refused('Give exactly one of app_path (a built .app to install and launch) or bundle_id (an app already on the simulator).');
    if (bundle && !BUNDLE_ID.test(bundle)) throw new Refused(`"${bundle}" is not a bundle id, like com.example.App.`);
    const app = appPath ? await this.appBundle(sessionId, appPath) : null;
    const device = await this.device(sessionId);
    const bundleId = app ? await this.simulator.install(device.udid, app) : bundle;
    // Watch the picture from before the launch, so the wait sees the app's first frames.
    const watch = this.simulator.watchForSettle(device.udid);
    try {
      const pid = await this.simulator.launch(device.udid, bundleId);
      const settled = await watch.arm();
      const installed = app ? `Installed ${app} and launched` : 'Launched';
      return { text: `${installed} ${bundleId} on ${deviceLabel(device)}${pid ? `, process ${pid}` : ''}. ${SETTLED[settled]}` };
    } finally {
      watch.stop();
    }
  }

  /** A built .app inside the session's folder or Xcode's build products (DerivedData). */
  private async appBundle(sessionId: string, given: string): Promise<string> {
    const directory = await this.host.directoryOf(sessionId);
    const target = isAbsolute(given) ? given : directory ? resolve(directory, given) : given;
    if (!existsSync(target)) throw new Refused(`No such app: ${target}`);
    let path: string | null = null;
    for (const root of [directory, this.derivedData]) {
      if (!root || !existsSync(root)) continue;
      try {
        path = resolveInside(root, target);
        break;
      } catch (error) {
        if (!(error instanceof OutsideFolder)) throw error;
      }
    }
    if (!path) throw new Refused(`${target} is outside this session's folder and Xcode's build products (${this.derivedData}). Build the app there first.`);
    if (!isAppBundle(path)) throw new Refused(`${path} is not a built app: give the .app folder Xcode produced (it holds an Info.plist).`);
    return path;
  }

  private async screenshot(sessionId: string): Promise<ToolResult> {
    const device = await this.device(sessionId);
    await this.simulator.learnOrientation(device.udid);
    const orientation = this.simulator.orientation(device.udid);
    const screen = await this.simulator.screen(device.udid).catch(() => null);
    const shown = screen ? shownSize(screen, orientation) : null;
    const picture = await this.simulator.screenshot(device.udid, shown?.width ?? 800);
    const about = shown && screen
      ? `The picture is ${shown.width}×${shown.height} pixels and 1 pixel is 1 device point, so its pixel coordinates are the x, y that sim_tap, sim_swipe and sim_pinch take (origin top-left). The screen is ${screen.width}×${screen.height} points at ${screen.scale}x, ${ORIENTATION_NAME[orientation]}.${orientation === 1 ? '' : ' The picture is the device as it is held: an app that does not rotate shows sideways (or upside down) in it, and the coordinates are still the picture\'s.'}`
      : 'The screen size in points could not be read, so the picture may not be at 1 pixel per point.';
    const limits = await this.limits(device.udid);
    return {
      text: `Screenshot of ${deviceLabel(device)}, shown to the user too. ${about}${limits ? `\nNot available on this device: ${limits}` : ''}`,
      image: { mediaType: picture.mediaType, data: picture.data.toString('base64') },
    };
  }

  /** What this device's input cannot do, in one line, or ''. */
  private async limits(udid: string): Promise<string> {
    const caps = await this.simulator.capabilities(udid);
    const missing = (['touch', 'multitouch', 'keyboard', 'buttons', 'rotate', 'shake'] as SimAbility[]).filter((a) => caps.reasons[a]);
    return [...new Set(missing.map((a) => `${a} (${caps.reasons[a]})`))].join('; ');
  }

  /** A point on the screen as shown, checked; still in the shown frame. */
  private async shownPoint(udid: string, x: unknown, y: unknown): Promise<Point> {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Refused('x and y must be numbers: device points, origin top-left, as in the picture from sim_screenshot.');
    await this.simulator.learnOrientation(udid);
    const shown = shownSize(await this.simulator.screen(udid), this.simulator.orientation(udid));
    if (x < 0 || y < 0 || x > shown.width || y > shown.height) throw new Refused(`(${x}, ${y}) is off the screen, which is ${shown.width}×${shown.height} points as shown. Take a screenshot to see it.`);
    return { x, y };
  }

  private async act(udid: string, request: Exclude<InputRequest, { op: 'orient' }>, done: string): Promise<ToolResult> {
    const outcome: InputOutcome = await this.simulator.send(udid, request);
    return outcome.ok ? { text: `${done}. Take a screenshot to see what happened.` } : { text: outcome.error, isError: true };
  }

  private async frame(udid: string) {
    await this.simulator.learnOrientation(udid);
    return { screen: await this.simulator.screen(udid), orientation: this.simulator.orientation(udid) };
  }

  private async tap(sessionId: string, args: { x?: unknown; y?: unknown; duration_ms?: unknown }): Promise<ToolResult> {
    const hold = args.duration_ms === undefined ? 0 : args.duration_ms;
    if (typeof hold !== 'number' || !Number.isFinite(hold) || hold < 0 || hold > MAX_HOLD_MS) throw new Refused(`duration_ms must be between 0 and ${MAX_HOLD_MS}.`);
    const device = await this.device(sessionId);
    const at = await this.shownPoint(device.udid, args.x, args.y);
    const { screen, orientation } = await this.frame(device.udid);
    const what = hold >= LONG_PRESS_MS ? `Long-pressed at ${at.x}, ${at.y} for ${hold} ms` : `Tapped at ${at.x}, ${at.y}`;
    return this.act(device.udid, { op: 'gesture', steps: tapGesture(at, hold, screen, orientation) }, what);
  }

  private async swipe(sessionId: string, args: { x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown; duration_ms?: unknown }): Promise<ToolResult> {
    const ms = args.duration_ms === undefined ? 300 : args.duration_ms;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 50 || ms > MAX_SWIPE_MS) throw new Refused(`duration_ms must be between 50 and ${MAX_SWIPE_MS}.`);
    const device = await this.device(sessionId);
    const from = await this.shownPoint(device.udid, args.x1, args.y1);
    const to = await this.shownPoint(device.udid, args.x2, args.y2);
    const { screen, orientation } = await this.frame(device.udid);
    const steps = swipeGesture(from, to, ms, screen, orientation);
    const edge = steps[0]?.edge ? ` (from the ${steps[0].edge} edge)` : '';
    return this.act(device.udid, { op: 'gesture', steps }, `Swiped from ${from.x}, ${from.y} to ${to.x}, ${to.y}${edge}`);
  }

  private async pinch(sessionId: string, args: { x?: unknown; y?: unknown; scale?: unknown; rotation_deg?: unknown; duration_ms?: unknown }): Promise<ToolResult> {
    const scale = args.scale;
    const rotation = args.rotation_deg === undefined ? 0 : args.rotation_deg;
    const ms = args.duration_ms === undefined ? 500 : args.duration_ms;
    const within = (v: unknown, [lo, hi]: readonly [number, number]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (!within(scale, PINCH_LIMITS.scale)) throw new Refused(`scale must be between ${PINCH_LIMITS.scale[0]} and ${PINCH_LIMITS.scale[1]}: above 1 spreads the fingers (zoom in), below 1 pinches them together.`);
    if (!within(rotation, PINCH_LIMITS.rotation)) throw new Refused(`rotation_deg must be between ${PINCH_LIMITS.rotation[0]} and ${PINCH_LIMITS.rotation[1]}.`);
    if (!within(ms, PINCH_LIMITS.duration)) throw new Refused(`duration_ms must be between ${PINCH_LIMITS.duration[0]} and ${PINCH_LIMITS.duration[1]}.`);
    const device = await this.device(sessionId);
    const at = await this.shownPoint(device.udid, args.x, args.y);
    const { screen, orientation } = await this.frame(device.udid);
    const steps = pinchGesture(at, scale as number, rotation as number, ms as number, screen, orientation);
    const turn = rotation ? `, turning ${rotation}°` : '';
    return this.act(device.udid, { op: 'gesture', steps }, `Pinched at ${at.x}, ${at.y} to ${scale}× apart${turn}`);
  }

  private async type(sessionId: string, args: { text?: unknown }): Promise<ToolResult> {
    if (typeof args.text !== 'string' || !args.text) throw new Refused('text is required.');
    if (args.text.length > MAX_TEXT) throw new Refused(`text is longer than ${MAX_TEXT} characters: type it in parts.`);
    const keys = textToKeys(args.text);
    if (!keys.ok) throw new Refused(`The simulator's keyboard is a US keyboard and cannot type ${keys.untypable.map((c) => JSON.stringify(c)).join(', ')}. Type the rest, and ask the user for those characters.`);
    const device = await this.device(sessionId);
    const steps = keys.steps.map((s, i) => ({ ...s, wait: s.down && i > 0 ? KEY_GAP_MS : 0 }));
    return this.act(device.udid, { op: 'keys', steps }, `Typed ${args.text.length} characters into the focused field`);
  }

  private async key(sessionId: string, args: { key?: unknown; modifiers?: unknown }): Promise<ToolResult> {
    if (typeof args.key !== 'string' || !args.key) throw new Refused('key is required: a name like return, escape, delete, tab, up, or one character like a.');
    const modifiers = args.modifiers === undefined ? [] : args.modifiers;
    if (!Array.isArray(modifiers) || !modifiers.every((m) => MODIFIERS.includes(m as Modifier))) throw new Refused(`modifiers must be a list of ${MODIFIERS.join(', ')}.`);
    const steps = namedKey(args.key, modifiers as Modifier[]);
    if (!steps) throw new Refused(`"${args.key}" is not a key: use return, escape, delete, forward_delete, tab, space, up, down, left, right, home, end, page_up, page_down, or one character from a US keyboard.`);
    const device = await this.device(sessionId);
    const combo = [...(modifiers as string[]), args.key].join('+');
    return this.act(device.udid, { op: 'keys', steps: steps.map((s) => ({ ...s, wait: 0 })) }, `Pressed ${combo}`);
  }

  private async button(sessionId: string, args: { button?: unknown }): Promise<ToolResult> {
    const button = args.button;
    if (button !== SHAKE && !SIM_BUTTONS.includes(button as SimButton)) throw new Refused(`button must be one of ${[...SIM_BUTTONS, SHAKE].join(', ')}.`);
    const device = await this.device(sessionId);
    if (button === SHAKE) return this.act(device.udid, { op: 'shake' }, 'Shook the device');
    return this.act(device.udid, { op: 'button', button: button as SimButton }, `Pressed ${BUTTON_LABEL[button as SimButton]}`);
  }

  private async openUrl(sessionId: string, args: { url?: unknown }): Promise<ToolResult> {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
    if (!scheme) throw new Refused('url must be a full address with a scheme, like https://example.com or myapp://path.');
    if (['file', 'javascript', 'data', 'about'].includes(scheme)) throw new Refused(`${scheme}: addresses are not opened in the simulator.`);
    if (url.length > 4000) throw new Refused('url is longer than 4000 characters.');
    const device = await this.device(sessionId);
    await this.simulator.openUrl(device.udid, url);
    return { text: `Opened ${url} on ${deviceLabel(device)}.` };
  }

  private async appearance(sessionId: string, args: { mode?: unknown }): Promise<ToolResult> {
    if (args.mode !== 'light' && args.mode !== 'dark') throw new Refused('mode must be light or dark.');
    const device = await this.device(sessionId);
    await this.simulator.setAppearance(device.udid, args.mode);
    return { text: `${deviceLabel(device)} is in ${args.mode} mode.` };
  }
}
