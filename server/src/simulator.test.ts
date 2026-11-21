import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeApproval, summarizeTool } from './agents/claude/describe.ts';
import { baseOptions } from './agents/claude/options.ts';
import { NO_TOOLS } from './agents/test-support.ts';
import { BUSY_FPS, FrameSource, QUIET_FPS, QUIET_MS, type FrameTimers } from './sim-frames.ts';
import { InputHelper, type InputTimers } from './sim-input.ts';
import type { Child, RunResult, Runner, Spawner } from './sim-process.ts';
import { SimTools } from './sim-tools.ts';
import { Simulator } from './simulator.ts';
import { PictureSettle, type SettleTimers } from './sim-settle.ts';
import { NEEDS_MAC, orientationFromDevicectl, osOfRuntime, parseDevices, pointerToDevice, rotate, shownSize, toDevicePoint } from './shared/simulator.ts';

// ---- fakes ----------------------------------------------------------------------------------

class FakeChild implements Child {
  written: string[] = [];
  killed = false;
  private out: ((c: Buffer) => void)[] = [];
  private err: ((c: Buffer) => void)[] = [];
  private exits: ((code: number | null) => void)[] = [];
  write(line: string) {
    this.written.push(line);
  }
  onStdout(l: (c: Buffer) => void) {
    this.out.push(l);
  }
  onStderr(l: (c: Buffer) => void) {
    this.err.push(l);
  }
  onExit(l: (code: number | null) => void) {
    this.exits.push(l);
  }
  kill() {
    this.killed = true;
  }
  stdout(data: Buffer | string) {
    for (const l of this.out) l(Buffer.from(data));
  }
  stderr(text: string) {
    for (const l of this.err) l(Buffer.from(text));
  }
  exit(code: number | null) {
    for (const l of this.exits) l(code);
  }
  /** The JSON lines written, parsed. */
  get sent(): Record<string, unknown>[] {
    return this.written.map((l) => JSON.parse(l));
  }
}

function spawner() {
  const children: { child: FakeChild; args: readonly string[] }[] = [];
  const spawn: Spawner = (_command, args) => {
    const child = new FakeChild();
    children.push({ child, args });
    return child;
  };
  return { spawn, children };
}

function frameTimers() {
  let now = 0;
  const ticks: (() => void)[] = [];
  const timers: FrameTimers = { every: (fn) => (ticks.push(fn), ticks.length - 1), clear: (h) => void (ticks[h as number] = () => undefined), now: () => now };
  return { timers, advance: (ms: number) => ((now += ms), ticks.forEach((t) => t())) };
}

function inputTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: InputTimers = { set: (fn) => (pending.set(++next, fn), next), clear: (h) => void pending.delete(h as number) };
  return { timers, fireAll: () => [...pending.values()].forEach((f) => f()) };
}

const record = (jpeg: string) => {
  const body = Buffer.from(jpeg);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.writeUInt16BE(10, 4);
  head.writeUInt16BE(20, 6);
  return Buffer.concat([head, body]);
};
const helperOk = async () => ({ ok: true as const, path: '/bin/kestrel-sim' });
const ALL = { touch: true, multitouch: true, keyboard: true, buttons: ['home', 'lock', 'siri', 'volume_up', 'volume_down'], rotate: true, shake: true };
/** The input helper's first line: CoreDevice input (everything), or the older path (one finger, Home). */
const readyLine = (size = { width: 400, height: 800 }, input: 'coredevice' | 'legacy' = 'coredevice') =>
  `${JSON.stringify({
    ready: true,
    ...size,
    scale: 3,
    input,
    capabilities: input === 'coredevice' ? ALL : { ...ALL, multitouch: false, keyboard: false, buttons: ['home'] },
    reasons: input === 'coredevice' ? {} : { multitouch: 'Two-finger gestures need CoreDevice input.', keyboard: 'Typing needs CoreDevice input.', buttons: 'Only Home works.' },
  })}\n`;
const flush = () => new Promise((r) => setImmediate(r));

const IPHONE_27 = '11111111-1111-1111-1111-111111111111';
const IPHONE_26 = '22222222-2222-2222-2222-222222222222';
const IPAD = '33333333-3333-3333-3333-333333333333';
const LISTING = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [
      { udid: IPHONE_27, name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'bad', name: 'Gone', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: IPHONE_26, name: 'iPhone 16', state: 'Booted', isAvailable: true },
      { udid: IPAD, name: 'iPad Air', state: 'Shutdown', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: '44444444-4444-4444-4444-444444444444', name: 'Watch', state: 'Booted' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': 'not a list',
  },
};

// ---- the shared rules -----------------------------------------------------------------------

describe('simulator devices as simctl lists them', () => {
  it('reads the OS from the runtime id, iOS only', () => {
    expect(osOfRuntime('com.apple.CoreSimulator.SimRuntime.iOS-26-5')).toBe('iOS 26.5');
    expect(osOfRuntime('com.apple.CoreSimulator.SimRuntime.iOS-27-0-1')).toBe('iOS 27.0.1');
    expect(osOfRuntime('com.apple.CoreSimulator.SimRuntime.watchOS-12-0')).toBeNull();
    expect(osOfRuntime('nonsense')).toBeNull();
  });

  it('lists available iOS devices, booted first, then newest OS, then by name', () => {
    expect(parseDevices(LISTING).map((d) => `${d.name} ${d.os} ${d.state}`)).toEqual(['iPhone 16 iOS 26.5 Booted', 'iPhone 17 Pro iOS 27.2 Shutdown', 'iPad Air iOS 26.5 Shutdown']);
  });

  it('skips anything malformed', () => {
    expect(parseDevices(null)).toEqual([]);
    expect(parseDevices({ devices: 3 })).toEqual([]);
    expect(parseDevices({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'x' }, null] } })).toEqual([]);
  });
});

describe('turning the device and pointing at it', () => {
  it('rotates clockwise to the right and back to the left', () => {
    expect(rotate(1, 'right')).toBe(4);
    expect(rotate(4, 'right')).toBe(2);
    expect(rotate(2, 'right')).toBe(3);
    expect(rotate(3, 'right')).toBe(1);
    expect(rotate(1, 'left')).toBe(3);
    for (const o of [1, 2, 3, 4] as const) expect(rotate(rotate(o, 'left'), 'right')).toBe(o);
  });

  const screen = { width: 400, height: 800 };

  it('swaps width and height in landscape', () => {
    expect(shownSize(screen, 1)).toEqual({ width: 400, height: 800 });
    expect(shownSize(screen, 3)).toEqual({ width: 800, height: 400 });
  });

  it('maps a point on the upright picture to the portrait frame in every orientation', () => {
    expect(toDevicePoint(10, 20, screen, 1)).toEqual({ x: 10, y: 20 });
    expect(toDevicePoint(10, 20, screen, 2)).toEqual({ x: 390, y: 780 });
    // Landscape left: the device's top is at the picture's left, so the picture's left edge is the device's top.
    expect(toDevicePoint(0, 0, screen, 3)).toEqual({ x: 400, y: 0 });
    expect(toDevicePoint(800, 400, screen, 3)).toEqual({ x: 0, y: 800 });
    expect(toDevicePoint(0, 0, screen, 4)).toEqual({ x: 0, y: 800 });
    expect(toDevicePoint(800, 400, screen, 4)).toEqual({ x: 400, y: 0 });
  });

  it('reads which way devicectl says the device is turned', () => {
    expect(orientationFromDevicectl(JSON.parse(devicectlOrientation('landscapeLeft')))).toBe(3);
    expect(orientationFromDevicectl(JSON.parse(devicectlOrientation('portraitUpsideDown')))).toBe(2);
    // Lying flat: the last upright orientation counts.
    expect(orientationFromDevicectl({ result: { deviceOrientation: 'faceUp', deviceOrientationNonFlat: 'landscapeRight' } })).toBe(4);
    expect(orientationFromDevicectl({ result: { deviceOrientation: 'faceUp' } })).toBeNull();
    expect(orientationFromDevicectl({})).toBeNull();
    expect(orientationFromDevicectl(null)).toBeNull();
  });

  it('maps a pointer in a scaled picture, and nothing outside it', () => {
    const box = { width: 200, height: 400 };
    expect(pointerToDevice(100, 200, box, screen, 1)).toEqual({ x: 200, y: 400 });
    expect(pointerToDevice(50, 100, box, screen, 1)).toEqual({ x: 100, y: 200 });
    expect(pointerToDevice(0, 0, { width: 400, height: 200 }, screen, 3)).toEqual({ x: 400, y: 0 });
    expect(pointerToDevice(33.333, 0, box, screen, 1)).toEqual({ x: 66.7, y: 0 });
    expect(pointerToDevice(-1, 0, box, screen, 1)).toBeNull();
    expect(pointerToDevice(0, 401, box, screen, 1)).toBeNull();
    expect(pointerToDevice(0, 0, { width: 0, height: 0 }, screen, 1)).toBeNull();
  });
});

// ---- the live picture -----------------------------------------------------------------------

describe('a device picture', () => {
  const setup = () => {
    const s = spawner();
    const t = frameTimers();
    const source = new FrameSource(IPHONE_26, helperOk, s.spawn, 1, t.timers);
    return { ...s, ...t, source };
  };
  const viewer = () => {
    const got: string[] = [];
    const errors: string[] = [];
    return { got, errors, sink: { frame: (j: Buffer) => got.push(j.toString()), error: (e: string) => errors.push(e) } };
  };

  it('starts the helper for the first viewer and stops it after the last', async () => {
    const { source, children } = setup();
    const a = viewer();
    const b = viewer();
    const stopA = source.subscribe(a.sink, 600);
    await flush();
    expect(children).toHaveLength(1);
    expect(children[0]!.args).toEqual(['frames', IPHONE_26]);
    expect(children[0]!.child.sent[0]).toEqual({ fps: BUSY_FPS, maxWidth: 600, orientation: 1 });
    const stopB = source.subscribe(b.sink, 1000);
    expect(children).toHaveLength(1);
    expect(children[0]!.child.sent.slice(1)).toEqual([{ maxWidth: 1000 }, { op: 'frame' }]);
    stopB();
    expect(children[0]!.child.sent.at(-1)).toEqual({ maxWidth: 600 });
    expect(source.watching).toBe(1);
    stopA();
    expect(children[0]!.child.killed).toBe(true);
    expect(source.watching).toBe(0);
    stopA(); // twice is harmless
  });

  it('passes pictures on, split across chunks, and drops identical ones', async () => {
    const { source, children } = setup();
    const a = viewer();
    source.subscribe(a.sink);
    await flush();
    const child = children[0]!.child;
    const both = Buffer.concat([record('one'), record('one'), record('two')]);
    child.stdout(both.subarray(0, 5));
    child.stdout(both.subarray(5, 14));
    child.stdout(both.subarray(14));
    expect(a.got).toEqual(['one', 'two']);
  });

  it('gives a new viewer the newest picture at once', async () => {
    const { source, children } = setup();
    source.subscribe(viewer().sink);
    await flush();
    children[0]!.child.stdout(record('now'));
    const late = viewer();
    source.subscribe(late.sink);
    expect(late.got).toEqual(['now']);
  });

  it('slows down after a quiet spell and speeds up on the next change', async () => {
    const { source, children, advance } = setup();
    source.subscribe(viewer().sink);
    await flush();
    const child = children[0]!.child;
    advance(QUIET_MS - 1);
    expect(source.rate).toBe(BUSY_FPS);
    advance(1);
    expect(source.rate).toBe(QUIET_FPS);
    expect(child.sent.at(-1)).toEqual({ fps: QUIET_FPS });
    child.stdout(record('moved'));
    expect(source.rate).toBe(BUSY_FPS);
    expect(child.sent.at(-1)).toEqual({ fps: BUSY_FPS });
  });

  it('tells viewers why the picture stopped', async () => {
    const { source, children } = setup();
    const a = viewer();
    source.subscribe(a.sink);
    await flush();
    children[0]!.child.stderr('{"ready":false,"error":"No booted device."}\n');
    children[0]!.child.exit(1);
    expect(a.errors).toEqual(['No booted device.']);
    expect(source.watching).toBe(0);
  });

  it('reports a helper that cannot be built', async () => {
    const s = spawner();
    const source = new FrameSource(IPHONE_26, async () => ({ ok: false, reason: 'Xcode is missing.' }), s.spawn, 1, frameTimers().timers);
    const a = viewer();
    source.subscribe(a.sink);
    await flush();
    expect(s.children).toHaveLength(0);
    expect(a.errors).toEqual(['Xcode is missing.']);
  });

  it('refuses an oversized record', async () => {
    const { source, children } = setup();
    const a = viewer();
    source.subscribe(a.sink);
    await flush();
    const head = Buffer.alloc(8);
    head.writeUInt32BE(64 * 1024 * 1024, 0);
    children[0]!.child.stdout(head);
    expect(a.errors[0]).toMatch(/could not read/);
    expect(children[0]!.child.killed).toBe(true);
  });
});

// ---- touches --------------------------------------------------------------------------------

describe('the touch helper', () => {
  it('reads the screen, then answers requests by id', async () => {
    const s = spawner();
    const input = new InputHelper(IPHONE_26, helperOk, s.spawn, inputTimers().timers);
    const screen = input.screen();
    await flush();
    const child = s.children[0]!.child;
    child.stdout(readyLine({ width: 402, height: 874 }));
    expect(await screen).toMatchObject({ ok: true, screen: { width: 402, height: 874, scale: 3 }, capabilities: { input: 'coredevice', keyboard: true } });
    const tap = input.send({ op: 'touch', phase: 'down', x: 1, y: 2 });
    await flush();
    expect(child.sent.at(-1)).toEqual({ id: 1, op: 'touch', phase: 'down', x: 1, y: 2 });
    child.stdout('{"id":1,"ok":false,"error":"nope"}\n');
    expect(await tap).toEqual({ ok: false, error: 'nope' });
  });

  it('ends a request when the helper goes away or does not answer', async () => {
    const s = spawner();
    const t = inputTimers();
    const input = new InputHelper(IPHONE_26, helperOk, s.spawn, t.timers);
    void input.screen();
    await flush();
    const child = s.children[0]!.child;
    child.stdout(readyLine());
    const gone = input.send({ op: 'button', button: 'home' });
    await flush();
    child.exit(0);
    expect(await gone).toEqual({ ok: false, error: 'The simulator helper stopped.' });
    const quiet = input.send({ op: 'shake' });
    await flush();
    s.children[1]!.child.stdout(readyLine());
    await flush();
    t.fireAll();
    expect((await quiet).ok).toBe(false);
  });
});

// ---- the simulator and the agent tools ------------------------------------------------------

/** devicectl's answer to `device orientation get --json-output -`. */
const devicectlOrientation = (name: string) => JSON.stringify({ info: { outcome: 'success' }, result: { deviceOrientation: name, deviceOrientationNonFlat: name } });

function fakeRun(listing: unknown = LISTING, orientation?: string) {
  const calls: string[][] = [];
  const run: Runner = async (command, args): Promise<RunResult> => {
    calls.push([command, ...args]);
    const joined = args.join(' ');
    if (joined.startsWith('devicectl device orientation get')) return orientation ? { code: 0, stdout: Buffer.from(devicectlOrientation(orientation)), stderr: '' } : { code: 1, stdout: Buffer.alloc(0), stderr: 'not supported' };
    if (joined.startsWith('simctl list')) return { code: 0, stdout: Buffer.from(JSON.stringify(listing)), stderr: '' };
    if (joined.startsWith('simctl launch')) return { code: 0, stdout: Buffer.from('com.example.Wren: 4242\n'), stderr: '' };
    if (command === '/usr/bin/plutil') return { code: 0, stdout: Buffer.from('com.example.Wren\n'), stderr: '' };
    if (command === '/bin/kestrel-sim') return { code: 0, stdout: Buffer.from('JPEG'), stderr: '' };
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  return { run, calls };
}

/** Settle timers that fire only when told: `fire()` runs every pending one. */
function settleTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: SettleTimers = { set: (fn) => (pending.set(++next, fn), next), clear: (h) => void pending.delete(h as number) };
  const fireLast = () => {
    const last = [...pending.entries()].at(-1);
    if (!last) return;
    pending.delete(last[0]);
    last[1]();
  };
  return { timers, pending, fire: () => [...pending.entries()].forEach(([k, f]) => (pending.delete(k), f())), fireLast };
}

function setupTools(options: { platform?: NodeJS.Platform; listing?: unknown; input?: 'coredevice' | 'legacy'; orientation?: string } = {}) {
  const { run, calls } = fakeRun(options.listing, options.orientation);
  const s = spawner();
  const settle = settleTimers();
  const simulator = new Simulator({ dataDir: '/nowhere', run, spawn: s.spawn, platform: options.platform ?? 'darwin', helper: { ensure: helperOk }, inputTimers: inputTimers().timers, frameTimers: frameTimers().timers, settleTimers: settle.timers });
  const folder = mkdtempSync(join(tmpdir(), 'kestrel-sim-test-'));
  const derived = mkdtempSync(join(tmpdir(), 'kestrel-sim-dd-'));
  const notices: string[] = [];
  const shown: string[] = [];
  const tools = new SimTools(simulator, { directoryOf: async () => folder, notice: (_s, text) => notices.push(text), show: (_s, udid) => shown.push(udid) }, derived);
  const inputs = () => s.children.filter((c) => c.args[0] === 'input').map((c) => c.child);
  // Answer the input helper as soon as it starts, and every request it was sent.
  const answer = async () => {
    await flush();
    for (const child of inputs()) if (!child.written.length) child.stdout(readyLine(undefined, options.input));
    await flush();
    for (const child of inputs()) for (const m of child.sent) child.stdout(`${JSON.stringify({ id: m.id, ok: true })}\n`);
  };
  /** Run a tool call while answering the helper; the last request it sent. */
  const call = async (work: Promise<{ text: string; isError?: boolean }>) => {
    for (let i = 0; i < 4; i++) await answer();
    const result = await work;
    return { result, sent: inputs()[0]?.sent.at(-1) as Record<string, unknown> | undefined };
  };
  return { simulator, tools, host: tools.hostFor('s1'), calls, children: s.children, folder, derived, notices, shown, answer, call, settle };
}

/** Wait for a call, running `tick` between turns of the event loop (fires timers the call waits on). */
async function untilDone<T>(work: Promise<T>, tick: () => void): Promise<T> {
  let done = false;
  void work.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 20 && !done; i++) {
    await flush();
    tick();
  }
  return work;
}

const app = (root: string, name = 'Wren.app') => {
  const path = join(root, 'Build', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'Info.plist'), '<plist/>');
  return path;
};

describe('the simulator outside a Mac', () => {
  it('answers that it needs macOS with Xcode', async () => {
    const { host, simulator } = setupTools({ platform: 'linux' });
    expect(await host.simList()).toEqual({ isError: true, text: NEEDS_MAC });
    const errors: string[] = [];
    simulator.watch(IPHONE_26, { frame: () => undefined, error: (e) => errors.push(e) }, 800);
    expect(errors).toEqual([NEEDS_MAC]);
  });
});

describe('the simulator tools', () => {
  it('list devices, booted first, and cache the listing briefly', async () => {
    const { host, calls } = setupTools();
    const r = await host.simList();
    expect(r.text.split('\n').slice(1)).toEqual([`iPhone 16 | iOS 26.5 | ${IPHONE_26} | Booted`, `iPhone 17 Pro | iOS 27.2 | ${IPHONE_27} | Shutdown`, `iPad Air | iOS 26.5 | ${IPAD} | Shutdown`]);
    await host.simList();
    expect(calls.filter((c) => c[2] === 'list')).toHaveLength(1);
  });

  it('boot a device by name, show it, and wait for it to start', async () => {
    const { host, calls, shown } = setupTools();
    const r = await host.simBoot({ device: 'iPhone 17 Pro' });
    expect(r.isError).toBeUndefined();
    expect(calls.map((c) => c.slice(1, 3).join(' '))).toEqual(expect.arrayContaining(['simctl boot', 'simctl bootstatus']));
    expect(shown).toEqual([IPHONE_27]);
  });

  it('refuse an unknown device with the known ones', async () => {
    const { host, notices } = setupTools();
    const r = await host.simBoot({ device: 'Pixel' });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/No simulator called "Pixel"\. Known: iPhone 16/);
    expect(notices[0]).toMatch(/^Kestrel refused sim_boot/);
  });

  it('refuse to act with nothing booted', async () => {
    const { host } = setupTools({ listing: { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: IPAD, name: 'iPad Air', state: 'Shutdown' }] } } });
    expect((await host.simScreenshot()).text).toMatch(/No simulator is booted/);
  });

  it('launch only a built app inside the session folder or the build products', async () => {
    const { host, folder, derived, calls, settle } = setupTools();
    const launched = (args: Parameters<typeof host.simLaunch>[0]) => untilDone(host.simLaunch(args), settle.fire);
    expect((await launched({})).text).toMatch(/exactly one of/);
    expect((await launched({ app_path: 'x.app', bundle_id: 'com.a.b' })).text).toMatch(/exactly one of/);
    expect((await launched({ bundle_id: 'not a bundle' })).text).toMatch(/is not a bundle id/);
    const outside = mkdtempSync(join(tmpdir(), 'kestrel-sim-outside-'));
    expect((await launched({ app_path: app(outside) })).text).toMatch(/outside this session's folder/);
    mkdirSync(join(folder, 'NotAnApp'));
    expect((await launched({ app_path: 'NotAnApp' })).text).toMatch(/is not a built app/);
    expect((await launched({ app_path: 'Missing.app' })).text).toMatch(/No such app/);

    const inFolder = await launched({ app_path: 'Build/Wren.app' });
    app(folder);
    const ok = await launched({ app_path: 'Build/Wren.app' });
    expect(inFolder.isError).toBe(true);
    expect(ok.text).toMatch(/Installed .*Wren\.app and launched com\.example\.Wren on iPhone 16 · iOS 26\.5, process 4242/);
    expect(calls).toContainEqual(['xcrun', 'simctl', 'launch', '--terminate-running-process', IPHONE_26, 'com.example.Wren']);
    expect((await launched({ app_path: app(derived, 'Other.app') })).isError).toBeUndefined();
    expect((await launched({ bundle_id: 'com.apple.Preferences' })).text).toMatch(/^Launched com\.apple\.Preferences.*could not watch the screen/);
  });

  it('wait after a launch until the app has drawn, counting only pictures from after the launch', async () => {
    const { host, settle, children } = setupTools();
    const pending = host.simLaunch({ bundle_id: 'com.apple.Preferences' });
    let done = false;
    void pending.then(() => (done = true));
    for (let i = 0; i < 10; i++) await flush();
    const frames = children.find((c) => c.args[0] === 'frames')!.child;
    frames.stdout(record('.'.repeat(5))); // blank: 5 bytes for 10×20 pixels
    expect(settle.pending.size).toBe(1); // only the time limit: a blank page does not count
    frames.stdout(record('#'.repeat(200))); // drawn
    settle.fireLast(); // it stayed still
    await flush();
    expect(done).toBe(true);
    expect((await pending).text).toMatch(/^Launched com\.apple\.Preferences on iPhone 16 · iOS 26\.5, process 4242\. It has drawn its first screen\./);
    expect(frames.killed).toBe(true);
  });

  it('take a screenshot at one pixel per point and say how big the screen is', async () => {
    const { host, answer, calls } = setupTools();
    const pending = host.simScreenshot();
    await answer();
    const r = await pending;
    expect(r.image).toEqual({ mediaType: 'image/jpeg', data: Buffer.from('JPEG').toString('base64') });
    expect(r.text).toMatch(/400×800 pixels and 1 pixel is 1 device point/);
    expect(calls).toContainEqual(['/bin/kestrel-sim', 'shot', IPHONE_26, '400', '1']);
  });

  it('take the screenshot the way the device is really turned, saying so, and map taps from it', async () => {
    const { host, answer, calls, call, simulator } = setupTools({ orientation: 'landscapeLeft' });
    const pending = host.simScreenshot();
    await answer();
    const r = await pending;
    expect(r.text).toMatch(/800×400 pixels .* landscape \(top to the left\)\. The picture is the device as it is held: an app that does not rotate shows sideways/);
    expect(calls).toContainEqual(['/bin/kestrel-sim', 'shot', IPHONE_26, '800', '3']);
    // devicectl is asked once per device, not per call.
    const tap = await call(host.simTap({ x: 0, y: 0 }));
    expect(tap.sent).toMatchObject({ steps: [{ phase: 'down', x: 400, y: 0 }, { phase: 'up', x: 400, y: 0 }] });
    expect(calls.filter((c) => c[1] === 'devicectl')).toHaveLength(1);
    expect(simulator.orientation(IPHONE_26)).toBe(3);
  });

  it('keep the orientation it knows when devicectl cannot say', async () => {
    const { host, answer } = setupTools();
    const pending = host.simScreenshot();
    await answer();
    expect((await pending).text).toMatch(/400×800 pixels .* portrait\./);
  });

  it('tap, long-press and swipe as finger reports in device points, refusing points off the screen', async () => {
    const { host, call } = setupTools();
    const tap = await call(host.simTap({ x: 100, y: 200 }));
    expect(tap.result.text).toMatch(/^Tapped at 100, 200/);
    expect(tap.sent).toMatchObject({ op: 'gesture', steps: [{ phase: 'down', x: 100, y: 200, wait: 0 }, { phase: 'up', x: 100, y: 200, wait: 60 }] });
    const hold = await call(host.simTap({ x: 100, y: 200, duration_ms: 800 }));
    expect(hold.result.text).toMatch(/^Long-pressed at 100, 200 for 800 ms/);
    expect((hold.sent!.steps as { wait: number }[])[1]!.wait).toBe(800);
    expect((await host.simTap({ x: 1, y: 1, duration_ms: -1 })).text).toMatch(/duration_ms must be between 0 and/);
    expect((await call(host.simTap({ x: 401, y: 0 }))).result.text).toMatch(/off the screen, which is 400×800/);
    expect((await host.simTap({ x: '1', y: 2 } as never)).text).toMatch(/must be numbers/);
    expect((await host.simSwipe({ x1: 10, y1: 700, x2: 10, y2: 100, duration_ms: 10 })).text).toMatch(/duration_ms must be between/);
    const swipe = await call(host.simSwipe({ x1: 10, y1: 700, x2: 10, y2: 100 }));
    expect(swipe.result.isError).toBeUndefined();
    const steps = swipe.sent!.steps as { phase: string; x: number; y: number; edge?: string }[];
    expect(steps[0]).toMatchObject({ phase: 'down', x: 10, y: 700 });
    expect(steps.at(-1)).toMatchObject({ phase: 'up', x: 10, y: 100 });
    expect(steps.every((st) => st.edge === undefined)).toBe(true);
    const home = await call(host.simSwipe({ x1: 200, y1: 800, x2: 200, y2: 400 }));
    expect(home.result.text).toMatch(/from the bottom edge/);
    expect((home.sent!.steps as { edge?: string }[]).every((st) => st.edge === 'bottom')).toBe(true);
  });

  it('pinch and turn with two fingers, and check the arguments', async () => {
    const { host, call } = setupTools();
    expect((await host.simPinch({ x: 200, y: 400, scale: 9 })).text).toMatch(/scale must be between 0.2 and 5/);
    expect((await host.simPinch({ x: 200, y: 400, scale: 2, rotation_deg: 720 })).text).toMatch(/rotation_deg must be between/);
    expect((await host.simPinch({ x: 200, y: 400, scale: 2, duration_ms: 20 })).text).toMatch(/duration_ms must be between 100/);
    const pinch = await call(host.simPinch({ x: 200, y: 400, scale: 2, rotation_deg: 90 }));
    expect(pinch.result.text).toMatch(/^Pinched at 200, 400 to 2× apart, turning 90°/);
    const steps = pinch.sent!.steps as { phase: string; x2?: number }[];
    expect(steps[0]).toMatchObject({ phase: 'down' });
    expect(steps.every((st) => typeof st.x2 === 'number')).toBe(true);
  });

  it('type text as US key presses, press named keys and refuse what a US keyboard cannot type', async () => {
    const { host, call } = setupTools();
    const typed = await call(host.simType({ text: 'Hi' }));
    expect(typed.result.text).toMatch(/^Typed 2 characters/);
    expect((typed.sent!.steps as { usage: number; down: boolean }[]).map((k) => `${k.usage}${k.down ? 'v' : '^'}`)).toEqual(['225v', '11v', '11^', '225^', '12v', '12^']);
    expect((await host.simType({ text: 'café' })).text).toMatch(/cannot type "é"/);
    expect((await host.simType({} as never)).text).toMatch(/text is required/);
    expect((await host.simType({ text: 'x'.repeat(2001) })).text).toMatch(/longer than 2000/);
    const select = await call(host.simKey({ key: 'a', modifiers: ['command'] }));
    expect(select.result.text).toMatch(/^Pressed command\+a/);
    expect(select.sent).toMatchObject({ op: 'keys', steps: [{ usage: 0xe3, down: true }, { usage: 4, down: true }, { usage: 4, down: false }, { usage: 0xe3, down: false }] });
    expect((await host.simKey({ key: 'banana' })).text).toMatch(/is not a key/);
    expect((await host.simKey({ key: 'a', modifiers: ['hyper'] } as never)).text).toMatch(/modifiers must be/);
  });

  it('press every hardware button and shake', async () => {
    const { host, call } = setupTools();
    for (const button of ['home', 'lock', 'siri', 'volume_up', 'volume_down'] as const) {
      const r = await call(host.simButton({ button }));
      expect(r.sent).toMatchObject({ op: 'button', button });
    }
    const shake = await call(host.simButton({ button: 'shake' }));
    expect(shake.result.text).toMatch(/^Shook the device/);
    expect(shake.sent).toMatchObject({ op: 'shake' });
    expect((await host.simButton({ button: 'power' } as never)).text).toMatch(/home, lock, siri, volume_up, volume_down, shake/);
  });

  it('refuse, with the helper\'s reason, what the older input path cannot do', async () => {
    const { host, call } = setupTools({ input: 'legacy' });
    expect((await call(host.simType({ text: 'hi' }))).result).toEqual({ isError: true, text: 'Typing needs CoreDevice input.' });
    expect((await call(host.simButton({ button: 'lock' }))).result.text).toBe('Lock is not available on this simulator: Only Home works.');
    expect((await call(host.simPinch({ x: 200, y: 400, scale: 2 }))).result.text).toBe('Two-finger gestures need CoreDevice input.');
    expect((await call(host.simButton({ button: 'home' }))).result.isError).toBeUndefined();
    const shot = await call(host.simScreenshot());
    expect(shot.result.text).toMatch(/Not available on this device: multitouch \(Two-finger gestures need CoreDevice input\.\); keyboard/);
  });

  it('open URLs but never files, scripts or data', async () => {
    const { host, calls } = setupTools();
    for (const url of ['file:///etc/passwd', 'JavaScript:alert(1)', 'data:text/html,x', 'about:blank']) expect((await host.simOpenUrl({ url })).isError).toBe(true);
    expect((await host.simOpenUrl({ url: 'example.com' })).text).toMatch(/with a scheme/);
    expect((await host.simOpenUrl({ url: 'wren://inbox' })).text).toMatch(/^Opened wren:\/\/inbox/);
    expect(calls).toContainEqual(['xcrun', 'simctl', 'openurl', IPHONE_26, 'wren://inbox']);
  });

  it('switch appearance, light or dark only', async () => {
    const { host, calls } = setupTools();
    expect((await host.simAppearance({ mode: 'sepia' } as never)).text).toMatch(/light or dark/);
    expect((await host.simAppearance({ mode: 'dark' })).text).toMatch(/is in dark mode/);
    expect(calls).toContainEqual(['xcrun', 'simctl', 'ui', IPHONE_26, 'appearance', 'dark']);
  });

  it('use the device the user picked in the pane', async () => {
    const listing = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: IPHONE_26, name: 'iPhone 16', state: 'Booted' }, { udid: IPAD, name: 'iPad Air', state: 'Booted' }] } };
    const { host, tools, shown } = setupTools({ listing });
    tools.choose('s1', IPAD);
    await host.simAppearance({ mode: 'light' });
    expect(shown).toEqual([IPAD]);
  });
});

describe('simulator tools in approvals and permissions', () => {
  it('have readable approval titles', () => {
    const t = (name: string, input: Record<string, unknown>) => summarizeTool(`mcp__kestrel__${name}`, input, '/w');
    expect(t('sim_boot', { device: 'iPhone 17 Pro' })).toBe('Boot iPhone 17 Pro');
    expect(t('sim_launch', { app_path: '/w/build/Wren.app' })).toBe('Launch Wren.app in the simulator');
    expect(t('sim_tap', { x: 120, y: 300 })).toBe('Tap at 120, 300');
    expect(t('sim_type', { text: 'secret' })).toBe('Type into the simulator');
    expect(t('sim_button', { button: 'home' })).toBe('Press Home in the simulator');
    expect(t('sim_button', { button: 'volume_down' })).toBe('Press Volume down in the simulator');
    expect(t('sim_button', { button: 'shake' })).toBe('Shake the simulator');
    expect(t('sim_tap', { x: 10, y: 20, duration_ms: 800 })).toBe('Long-press at 10, 20');
    expect(t('sim_pinch', { x: 200, y: 400, scale: 2, rotation_deg: 45 })).toBe('Pinch at 200, 400 to 2×, turning 45°');
    expect(t('sim_pinch', { x: 200, y: 400, scale: 0.5 })).toBe('Pinch at 200, 400 to 0.5×');
    expect(t('sim_key', { key: 'z', modifiers: ['shift', 'command'] })).toBe('Press ⇧⌘Z in the simulator');
    expect(t('sim_key', { key: 'page_down' })).toBe('Press Page down in the simulator');
    expect(describeApproval('mcp__kestrel__sim_type', { text: 'hello' }, '/w')).toEqual({ title: 'Type into the simulator', detail: 'hello' });
    expect(t('sim_list', {})).toBe('List the simulators');
    expect(describeApproval('mcp__kestrel__sim_tap', { x: 120, y: 300 }, '/w').title).toBe('Tap at 120, 300');
  });

  it('ask before acting in Manual, and only list and look in a read-only session', () => {
    const manual = baseOptions({ directory: '/w', permission: 'ask', instruction: 'x', tools: NO_TOOLS });
    for (const t of ['sim_list', 'sim_screenshot', 'sim_appearance']) expect(manual.allowedTools).toContain(`mcp__kestrel__${t}`);
    for (const t of ['sim_boot', 'sim_launch', 'sim_tap', 'sim_swipe', 'sim_pinch', 'sim_type', 'sim_key', 'sim_button', 'sim_open_url']) expect(manual.allowedTools).not.toContain(`mcp__kestrel__${t}`);
    const readOnly = baseOptions({ directory: '/w', permission: 'readonly', instruction: 'x', tools: NO_TOOLS });
    expect(readOnly.allowedTools).toEqual(expect.arrayContaining(['mcp__kestrel__sim_list', 'mcp__kestrel__sim_screenshot']));
    for (const t of ['sim_boot', 'sim_launch', 'sim_tap', 'sim_swipe', 'sim_pinch', 'sim_type', 'sim_key', 'sim_button', 'sim_open_url', 'sim_appearance']) expect(readOnly.disallowedTools).toContain(`mcp__kestrel__${t}`);
  });
});
