// Everything Kestrel does with the iOS Simulator, for the pane and the agent tools alike: listing
// devices, booting, installing and launching apps, pictures, touches, rotation and appearance.
// Short jobs are `xcrun simctl`; touches and the live picture go through the `kestrel-sim` helper
// (sim-helper.ts, sim-input.ts, sim-frames.ts). Every command goes through one injectable runner.
// macOS only: elsewhere every call answers NEEDS_MAC.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FrameSource, type FrameTimers, type FrameViewer } from './sim-frames.ts';
import { SimHelper } from './sim-helper.ts';
import { InputHelper, type InputOutcome, type InputRequest, type InputTimers } from './sim-input.ts';
import { runCommand, spawnChild, type Runner, type Spawner } from './sim-process.ts';
import { PictureSettle, type SettleOutcome, type SettleTimers } from './sim-settle.ts';
import { cannot, NEEDS_MAC, noCapabilities, NO_SIMULATORS, orientationFromDevicectl, parseDevices, type Orientation, type SimCapabilities, type SimDevice, type SimScreen } from './shared/simulator.ts';
import { Refused } from './workspace.ts';

const LIST_CACHE_MS = 2_000;
const BOOT_TIMEOUT_MS = 180_000;
const SHOT_WIDTH_LIMIT = 1600;
/** devicectl's first call starts CoreDevice and can take ten seconds. */
const ORIENTATION_TIMEOUT_MS = 20_000;
/** The picture used to tell when a launched app has drawn: small is enough. */
const SETTLE_WIDTH = 300;

export interface SimulatorOptions {
  dataDir: string;
  run?: Runner;
  spawn?: Spawner;
  platform?: NodeJS.Platform;
  now?: () => number;
  frameTimers?: FrameTimers;
  inputTimers?: InputTimers;
  settleTimers?: SettleTimers;
  helper?: Pick<SimHelper, 'ensure'>;
}

export class Simulator {
  private readonly run: Runner;
  private readonly spawn: Spawner;
  private readonly mac: boolean;
  private readonly now: () => number;
  private readonly helper: Pick<SimHelper, 'ensure'>;
  private listed: { at: number; devices: Promise<SimDevice[]> } | null = null;
  private readonly orientations = new Map<string, Orientation>();
  /** Asking the device which way it is turned, once per device per boot (see learnOrientation). */
  private readonly learning = new Map<string, Promise<void>>();
  private readonly frames = new Map<string, FrameSource>();
  private readonly inputs = new Map<string, InputHelper>();
  private readonly changeListeners = new Set<(udid: string) => void>();

  constructor(private readonly options: SimulatorOptions) {
    this.run = options.run ?? runCommand;
    this.spawn = options.spawn ?? spawnChild;
    this.mac = (options.platform ?? process.platform) === 'darwin';
    this.now = options.now ?? Date.now;
    this.helper = options.helper ?? new SimHelper(this.run, options.dataDir);
  }

  /** Called when a device's state or orientation changes, so windows can refresh. */
  onChange(listener: (udid: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(udid: string): void {
    this.listed = null;
    for (const l of this.changeListeners) l(udid);
  }

  private needMac(): void {
    if (!this.mac) throw new Refused(NEEDS_MAC);
  }

  private async simctl(args: readonly string[], timeoutMs?: number): Promise<string> {
    const r = await this.run('xcrun', ['simctl', ...args], { timeoutMs });
    if (r.code === -1 && /ENOENT/.test(r.stderr)) throw new Refused(NEEDS_MAC);
    if (r.code !== 0) throw new Refused(`simctl ${args[0]} failed: ${firstLines(r.stderr) || `exit ${r.code}`}`);
    return r.stdout.toString();
  }

  // ---- devices ------------------------------------------------------------------------------

  /** iOS devices, booted first. Cached for two seconds. */
  async devices(): Promise<SimDevice[]> {
    this.needMac();
    const at = this.now();
    if (this.listed && at - this.listed.at < LIST_CACHE_MS) return this.listed.devices;
    const devices = this.simctl(['list', 'devices', 'available', '--json'], 20_000).then((out) => {
      try {
        return parseDevices(JSON.parse(out));
      } catch {
        throw new Refused('simctl listed the devices in a form Kestrel could not read.');
      }
    });
    this.listed = { at, devices };
    devices.catch(() => {
      if (this.listed?.devices === devices) this.listed = null;
    });
    return devices;
  }

  /** A device by udid, or by name (a booted one first, then the newest OS). */
  async find(device: string): Promise<SimDevice> {
    const wanted = device.trim();
    if (!wanted) throw new Refused('device is empty. Give a simulator name like "iPhone 17 Pro" or its udid (see sim_list).');
    const all = await this.devices();
    if (!all.length) throw new Refused(NO_SIMULATORS);
    const found = all.find((d) => d.udid.toLowerCase() === wanted.toLowerCase()) ?? all.find((d) => d.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new Refused(`No simulator called "${wanted}". Known: ${all.slice(0, 12).map((d) => `${d.name} (${d.os})`).join(', ')}.`);
    return found;
  }

  async booted(): Promise<SimDevice[]> {
    return (await this.devices()).filter((d) => d.state === 'Booted');
  }

  /** Boot a device and wait until it has finished starting. Booting a booted device is fine. */
  async boot(udid: string): Promise<SimDevice> {
    this.needMac();
    const device = await this.find(udid);
    if (device.state !== 'Booted') {
      const r = await this.run('xcrun', ['simctl', 'boot', device.udid], { timeoutMs: 60_000 });
      // "Unable to boot device in current state: Booted" is not a failure.
      if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) throw new Refused(`Could not boot ${device.name}: ${firstLines(r.stderr) || `exit ${r.code}`}`);
      this.changed(device.udid);
    }
    await this.simctl(['bootstatus', device.udid, '-b'], BOOT_TIMEOUT_MS);
    this.forgetOrientation(device.udid);
    this.changed(device.udid);
    return { ...device, state: 'Booted' };
  }

  async shutdown(udid: string): Promise<void> {
    this.needMac();
    this.frames.get(udid)?.close('The simulator was shut down.');
    this.inputs.get(udid)?.stop();
    await this.simctl(['shutdown', udid], 60_000);
    this.forgetOrientation(udid);
    this.changed(udid);
  }

  private async requireBooted(udid: string): Promise<SimDevice> {
    const device = await this.find(udid);
    if (device.state !== 'Booted') throw new Refused(`${device.name} is not booted. Boot it first.`);
    return device;
  }

  // ---- apps -----------------------------------------------------------------------------------

  /** Install a built .app (already validated by the caller) and return its bundle id. */
  async install(udid: string, appPath: string): Promise<string> {
    await this.requireBooted(udid);
    const plist = join(appPath, 'Info.plist');
    if (!existsSync(plist)) throw new Refused(`${basename(appPath)} has no Info.plist: is it a built iOS app?`);
    const id = await this.run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeoutMs: 10_000 });
    const bundleId = id.stdout.toString().trim();
    if (id.code !== 0 || !bundleId) throw new Refused(`Could not read the bundle id of ${basename(appPath)}.`);
    await this.simctl(['install', udid, appPath], 120_000);
    return bundleId;
  }

  /** Launch an installed app; its process id. A running copy is restarted. */
  async launch(udid: string, bundleId: string): Promise<number | null> {
    await this.requireBooted(udid);
    const out = await this.simctl(['launch', '--terminate-running-process', udid, bundleId], 60_000);
    const pid = /:\s*(\d+)\s*$/.exec(out.trim())?.[1];
    return pid ? Number(pid) : null;
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.requireBooted(udid);
    await this.simctl(['openurl', udid, url], 30_000);
  }

  async appearance(udid: string): Promise<'light' | 'dark' | 'unknown'> {
    await this.requireBooted(udid);
    const out = (await this.simctl(['ui', udid, 'appearance'], 15_000)).trim();
    return out === 'light' || out === 'dark' ? out : 'unknown';
  }

  async setAppearance(udid: string, mode: 'light' | 'dark'): Promise<void> {
    await this.requireBooted(udid);
    await this.simctl(['ui', udid, 'appearance', mode], 15_000);
    this.changed(udid);
  }

  /** Simulator.app on this device: the escape hatch for what the pane cannot do. */
  async openSimulatorApp(udid: string): Promise<void> {
    this.needMac();
    const r = await this.run('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { timeoutMs: 20_000 });
    if (r.code !== 0) throw new Refused(`Could not open Simulator.app: ${firstLines(r.stderr) || `exit ${r.code}`}`);
  }

  // ---- pictures -------------------------------------------------------------------------------

  orientation(udid: string): Orientation {
    return this.orientations.get(udid) ?? 1;
  }

  private setOrientation(udid: string, orientation: Orientation): void {
    this.orientations.set(udid, orientation);
    this.frames.get(udid)?.setOrientation(orientation);
    this.changed(udid);
  }

  /**
   * Ask the device which way it is turned, once: it may have been turned in Simulator.app or
   * before this server started, and the picture and touch points must follow the real device.
   * Never throws; a device or Xcode that cannot say leaves the orientation as Kestrel knows it.
   */
  learnOrientation(udid: string): Promise<void> {
    if (!this.mac) return Promise.resolve();
    let pending = this.learning.get(udid);
    if (pending) return pending;
    const known = this.orientations.get(udid);
    pending = this.run('xcrun', ['devicectl', 'device', 'orientation', 'get', '--device', udid, '--quiet', '--json-output', '-'], { timeoutMs: ORIENTATION_TIMEOUT_MS }).then(
      (r) => {
        if (r.code !== 0) return;
        let found: Orientation | null = null;
        try {
          found = orientationFromDevicectl(JSON.parse(r.stdout.toString()));
        } catch {
          return;
        }
        // A rotation made meanwhile is newer than this answer.
        if (found && this.orientations.get(udid) === known && found !== this.orientation(udid)) this.setOrientation(udid, found);
      },
      () => undefined,
    );
    this.learning.set(udid, pending);
    return pending;
  }

  /** The screen as a JPEG at most `maxWidth` pixels wide, upright. Uses the helper; falls back to simctl. */
  async screenshot(udid: string, maxWidth: number): Promise<{ mediaType: 'image/jpeg'; data: Buffer }> {
    await this.requireBooted(udid);
    await this.learnOrientation(udid);
    const width = String(Math.min(SHOT_WIDTH_LIMIT, Math.max(100, Math.round(maxWidth))));
    const helper = await this.helper.ensure();
    if (helper.ok) {
      const r = await this.run(helper.path, ['shot', udid, width, String(this.orientation(udid))], { timeoutMs: 20_000 });
      if (r.code === 0 && r.stdout.length > 0) return { mediaType: 'image/jpeg', data: r.stdout };
    }
    // simctl cannot write to stdout on this Xcode ("-" becomes a file), so it goes through a file.
    const file = join(tmpdir(), `kestrel-sim-${randomUUID()}.jpg`);
    try {
      await this.simctl(['io', udid, 'screenshot', '--type=jpeg', file], 30_000);
      return { mediaType: 'image/jpeg', data: readFileSync(file) };
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Watch a device's live picture. The helper runs while anyone watches. */
  watch(udid: string, viewer: FrameViewer, maxWidth: number): () => void {
    if (!this.mac) {
      viewer.error(NEEDS_MAC);
      return () => undefined;
    }
    void this.learnOrientation(udid);
    let source = this.frames.get(udid);
    if (!source) {
      source = new FrameSource(udid, () => this.helper.ensure(), this.spawn, this.orientation(udid), this.options.frameTimers);
      this.frames.set(udid, source);
    }
    return source.subscribe(viewer, maxWidth);
  }

  // ---- input ----------------------------------------------------------------------------------

  private input(udid: string): InputHelper {
    let helper = this.inputs.get(udid);
    if (!helper) {
      helper = new InputHelper(udid, () => this.helper.ensure(), this.spawn, this.options.inputTimers);
      this.inputs.set(udid, helper);
    }
    return helper;
  }

  /** The portrait screen in points (from the helper, which reads the device type). */
  async screen(udid: string): Promise<SimScreen> {
    await this.requireBooted(udid);
    const r = await this.input(udid).screen();
    if (!r.ok) throw new Refused(r.error);
    return r.screen;
  }

  /** What this device's input can do, and why not where it cannot. Never throws for a booted device. */
  async capabilities(udid: string): Promise<SimCapabilities> {
    if (!this.mac) return noCapabilities(NEEDS_MAC);
    const device = await this.find(udid);
    if (device.state !== 'Booted') return noCapabilities(`${device.name} is not booted.`);
    const r = await this.input(udid).screen();
    return r.ok ? r.capabilities : noCapabilities(r.error);
  }

  /** Touches, gestures, keys, buttons, shake; device points in the portrait frame. Refused up front when the device cannot. */
  async send(udid: string, request: Exclude<InputRequest, { op: 'orient' }>): Promise<InputOutcome> {
    await this.requireBooted(udid);
    const ready = await this.input(udid).screen();
    if (!ready.ok) return ready;
    const reason = cannot(ready.capabilities, needed(request));
    if (reason) return { ok: false, error: reason };
    return this.input(udid).send(request);
  }

  /**
   * Watch the picture so that `arm()` (called once the app is launched) resolves when the app has
   * drawn: not blank and still for a moment, or after SETTLE_LIMIT_MS. `stop()` always.
   */
  watchForSettle(udid: string): { arm(): Promise<SettleOutcome>; stop(): void } {
    const settle = new PictureSettle(this.options.settleTimers ?? realSettleTimers);
    const stop = this.watch(udid, settle, SETTLE_WIDTH);
    return { arm: () => settle.arm(), stop };
  }

  private forgetOrientation(udid: string): void {
    this.learning.delete(udid);
    this.orientations.delete(udid);
  }

  /** Turn the device; the live picture follows. */
  async rotate(udid: string, orientation: Orientation): Promise<void> {
    await this.requireBooted(udid);
    const caps = await this.capabilities(udid);
    const reason = cannot(caps, 'rotate');
    if (reason) throw new Refused(reason);
    const r = await this.input(udid).send({ op: 'orient', orientation });
    if (!r.ok) throw new Refused(r.error);
    this.setOrientation(udid, orientation);
  }

  /** Stop every helper. */
  close(): void {
    for (const f of this.frames.values()) f.close('Kestrel is closing.');
    for (const i of this.inputs.values()) i.stop();
  }
}

/** A path is a built .app: a directory named *.app with an Info.plist. */
export function isAppBundle(path: string): boolean {
  try {
    return path.endsWith('.app') && statSync(path).isDirectory() && existsSync(join(path, 'Info.plist'));
  } catch {
    return false;
  }
}

/** The ability a request needs. */
function needed(request: Exclude<InputRequest, { op: 'orient' }>): Parameters<typeof cannot>[1] {
  switch (request.op) {
    case 'touch':
      return request.x2 === undefined ? 'touch' : 'multitouch';
    case 'gesture':
      return request.steps.some((s) => s.x2 !== undefined) ? 'multitouch' : 'touch';
    case 'keys':
      return 'keyboard';
    case 'button':
      return { button: request.button };
    case 'shake':
      return 'shake';
  }
}

const realSettleTimers: SettleTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

const firstLines =(text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ').slice(0, 400);
