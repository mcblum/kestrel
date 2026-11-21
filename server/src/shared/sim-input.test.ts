import { describe, expect, it } from 'vitest';
import {
  cannot,
  chord,
  edgeOf,
  gestureMs,
  isKeySteps,
  keyForDevice,
  mirrored,
  namedKey,
  noCapabilities,
  parseCapabilities,
  pinchGesture,
  STEP_MS,
  swipeGesture,
  tapGesture,
  textToKeys,
  type KeyPress,
  type KeyStep,
} from './simulator.ts';

const screen = { width: 400, height: 800 };
const keys = (steps: KeyStep[]) => steps.map((k) => `${k.usage}${k.down ? 'v' : '^'}`);

describe('what a device can do', () => {
  it('reads the helper ready line, claiming only what it claims', () => {
    const caps = parseCapabilities({
      ready: true,
      input: 'coredevice',
      capabilities: { touch: true, multitouch: true, keyboard: true, buttons: ['home', 'lock', 'siri', 'volume_up', 'volume_down', 'teleport'], rotate: true, shake: true },
      reasons: {},
    });
    expect(caps).toEqual({ input: 'coredevice', touch: true, multitouch: true, keyboard: true, buttons: ['home', 'lock', 'siri', 'volume_up', 'volume_down'], rotate: true, shake: true, reasons: {} });
    expect(cannot(caps, 'keyboard')).toBeNull();
    expect(cannot(caps, { button: 'siri' })).toBeNull();
  });

  it('keeps the helper reasons for what the older path cannot do', () => {
    const caps = parseCapabilities({ ready: true, input: 'legacy', capabilities: { touch: true, multitouch: false, keyboard: false, buttons: ['home'], rotate: true, shake: true }, reasons: { keyboard: 'Typing needs CoreDevice input.', buttons: 'Only Home works.' } });
    expect(caps.input).toBe('legacy');
    expect(cannot(caps, 'touch')).toBeNull();
    expect(cannot(caps, 'keyboard')).toBe('Typing needs CoreDevice input.');
    expect(cannot(caps, { button: 'lock' })).toBe('Lock is not available on this simulator: Only Home works.');
    expect(cannot(caps, 'multitouch')).toMatch(/did not say it can do this/);
  });

  it('treats a helper that says nothing (an older build) as able to do nothing', () => {
    const caps = parseCapabilities({ ready: true, width: 400, height: 800, scale: 3 });
    expect(caps).toMatchObject({ input: 'none', touch: false, keyboard: false, buttons: [], rotate: false, shake: false });
    expect(cannot(caps, 'shake')).toMatch(/did not say/);
  });

  it('gives every ability one reason when nothing works', () => {
    const caps = noCapabilities('The simulator is not booted.');
    expect(cannot(caps, 'touch')).toBe('The simulator is not booted.');
    expect(cannot(caps, { button: 'home' })).toBe('Home is not available on this simulator: The simulator is not booted.');
  });
});

describe('gestures as finger reports', () => {
  it('taps for 60 ms, and holds a long-press as long as asked', () => {
    expect(tapGesture({ x: 10, y: 20 }, 0, screen, 1)).toEqual([
      { phase: 'down', x: 10, y: 20, wait: 0 },
      { phase: 'up', x: 10, y: 20, wait: 60 },
    ]);
    expect(tapGesture({ x: 10, y: 20 }, 800, screen, 1)[1]!.wait).toBe(800);
  });

  it('maps a tap on the upright picture into the device frame in landscape', () => {
    // Landscape left: the picture is 800×400 and its left edge is the device's top.
    expect(tapGesture({ x: 0, y: 0 }, 0, screen, 3)[0]).toMatchObject({ x: 400, y: 0 });
    expect(tapGesture({ x: 800, y: 400 }, 0, screen, 4)[0]).toMatchObject({ x: 400, y: 0 });
  });

  it('swipes with a report every 16 ms, ending where asked, taking the time asked', () => {
    const steps = swipeGesture({ x: 200, y: 600 }, { x: 200, y: 200 }, 320, screen, 1);
    expect(steps[0]).toEqual({ phase: 'down', x: 200, y: 600, wait: 0 });
    expect(steps.slice(1, -1).every((s) => s.phase === 'move' && s.wait === STEP_MS)).toBe(true);
    expect(steps).toHaveLength(1 + 20 + 1);
    expect(steps.at(-2)).toMatchObject({ x: 200, y: 200 });
    expect(steps.at(-1)).toEqual({ phase: 'up', x: 200, y: 200, wait: STEP_MS });
    expect(gestureMs(steps)).toBe(320 + STEP_MS);
    // y goes down steadily: what iOS reads as a constant-speed flick.
    const ys = steps.map((s) => s.y);
    expect(ys.every((y, i) => i === 0 || y <= ys[i - 1]!)).toBe(true);
  });

  it('marks a swipe that starts on the border as an edge gesture, in the device frame', () => {
    expect(swipeGesture({ x: 200, y: 799 }, { x: 200, y: 400 }, 200, screen, 1).every((s) => s.edge === 'bottom')).toBe(true);
    expect(swipeGesture({ x: 300, y: 1 }, { x: 300, y: 400 }, 200, screen, 1)[0]!.edge).toBe('top');
    expect(swipeGesture({ x: 0, y: 400 }, { x: 300, y: 400 }, 200, screen, 1)[0]!.edge).toBe('left');
    expect(swipeGesture({ x: 100, y: 400 }, { x: 300, y: 400 }, 200, screen, 1)[0]!.edge).toBeUndefined();
    // In landscape left the picture's left edge is the device's top.
    expect(swipeGesture({ x: 1, y: 200 }, { x: 400, y: 200 }, 200, screen, 3)[0]!.edge).toBe('top');
    expect(edgeOf({ x: 0, y: 800 }, screen)).toBe('bottom');
    expect(edgeOf({ x: 398, y: 300 }, screen)).toBe('right');
  });

  it('spreads two fingers by the scale around the centre', () => {
    const steps = pinchGesture({ x: 200, y: 400 }, 3, 0, 160, screen, 1);
    const first = steps[0]!;
    const last = steps.at(-1)!;
    expect(first).toEqual({ phase: 'down', x: 160, y: 400, x2: 240, y2: 400, wait: 0 });
    expect(last).toMatchObject({ phase: 'up', x: 80, y: 400, x2: 320, y2: 400 });
    expect(steps).toHaveLength(1 + 10 + 1);
    expect(gestureMs(steps)).toBe(160 + STEP_MS);
    // The centre never moves.
    for (const s of steps) expect([(s.x + s.x2!) / 2, (s.y + s.y2!) / 2]).toEqual([200, 400]);
  });

  it('turns the fingers clockwise for a positive angle, as the user sees it', () => {
    const steps = pinchGesture({ x: 200, y: 400 }, 1, 90, 160, screen, 1);
    // From left/right of the centre to above/below it: the left finger ends on top (clockwise on screen).
    expect(steps[0]).toMatchObject({ x: 160, y: 400, x2: 240, y2: 400 });
    expect(steps.at(-1)).toMatchObject({ x: 200, y: 360, x2: 200, y2: 440 });
    const anti = pinchGesture({ x: 200, y: 400 }, 1, -90, 160, screen, 1).at(-1)!;
    expect(anti).toMatchObject({ x: 200, y: 440, x2: 200, y2: 360 });
  });

  it('keeps the turn clockwise as seen in landscape, by mapping every point', () => {
    // Shown 800×400 in landscape left; the same picture gesture, mapped point by point.
    const shown = pinchGesture({ x: 400, y: 200 }, 1, 90, 160, screen, 3);
    // The left finger starts at shown (360, 200) -> device (W - y, x) = (200, 360) and ends above the centre, shown (400, 160) -> (240, 400).
    expect(shown[0]).toMatchObject({ x: 200, y: 360 });
    expect(shown.at(-1)).toMatchObject({ x: 240, y: 400 });
  });

  it('turns first and spreads after when asked for both, so apps that lock to zoom still turn', () => {
    const steps = pinchGesture({ x: 200, y: 400 }, 3, 90, 160, screen, 1);
    const half = steps[5]!; // t = 0.5: fully turned, not yet spread
    expect(half).toMatchObject({ x: 200, y: 360, x2: 200, y2: 440 });
    expect(steps.at(-1)).toMatchObject({ x: 200, y: 280, x2: 200, y2: 520 });
  });

  it('keeps both fingers on the screen near an edge', () => {
    const steps = pinchGesture({ x: 5, y: 5 }, 5, 0, 100, screen, 1);
    for (const s of steps) for (const v of [s.x, s.y, s.x2!, s.y2!]) expect(v).toBeGreaterThanOrEqual(1);
  });

  it("mirrors the pane's first finger through the centre for the second", () => {
    expect(mirrored({ x: 100, y: 300 }, screen)).toEqual({ x: 300, y: 500 });
  });
});

describe('keys for the simulator', () => {
  const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

  it('holds modifiers around a key, releasing them in reverse', () => {
    expect(keys(chord(4, ['shift', 'command']))).toEqual(['227v', '225v', '4v', '4^', '225^', '227^']);
  });

  it('types US-keyboard text, with shift for capitals and symbols, Return for new lines', () => {
    const r = textToKeys('aZ!\n');
    expect(r.ok && keys(r.steps)).toEqual(['4v', '4^', '225v', '29v', '29^', '225^', '225v', '30v', '30^', '225^', '40v', '40^']);
    expect(textToKeys('naïve 😀')).toEqual({ ok: false, untypable: ['ï', '😀'] });
  });

  it('names keys for sim_key, and adds shift for shifted characters', () => {
    expect(keys(namedKey('return')!)).toEqual(['40v', '40^']);
    expect(keys(namedKey('Escape')!)).toEqual(['41v', '41^']);
    expect(keys(namedKey('left', ['shift'])!)).toEqual(['225v', '80v', '80^', '225^']);
    expect(keys(namedKey('?')!)).toEqual(['225v', '56v', '56^', '225^']);
    expect(namedKey('banana')).toBeNull();
  });

  it('forwards text and editing keys from the Mac, by physical key', () => {
    expect(keys(keyForDevice(press('KeyH', { shiftKey: true }))!)).toEqual(['225v', '11v', '11^', '225^']);
    expect(keys(keyForDevice(press('Backspace'))!)).toEqual(['42v', '42^']);
    expect(keys(keyForDevice(press('Enter'))!)).toEqual(['40v', '40^']);
    expect(keys(keyForDevice(press('ArrowUp'))!)).toEqual(['82v', '82^']);
    expect(keys(keyForDevice(press('Tab'))!)).toEqual(['43v', '43^']);
    expect(keys(keyForDevice(press('Escape'))!)).toEqual(['41v', '41^']);
    expect(keys(keyForDevice(press('KeyE', { altKey: true }))!)).toEqual(['226v', '8v', '8^', '226^']);
  });

  it('forwards ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z and ⇧⌘Z to the device', () => {
    for (const code of ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ']) expect(keyForDevice(press(code, { metaKey: true }))?.[0]).toEqual({ usage: 0xe3, down: true });
    expect(keys(keyForDevice(press('KeyZ', { metaKey: true, shiftKey: true }))!)).toEqual(['227v', '225v', '29v', '29^', '225^', '227^']);
  });

  it("leaves Kestrel's shortcuts, Control chords and keys the device lacks to Kestrel", () => {
    for (const code of ['KeyK', 'KeyN', 'KeyW', 'KeyT', 'Digit1', 'Digit9', 'Comma', 'BracketLeft']) expect(keyForDevice(press(code, { metaKey: true }))).toBeNull();
    expect(keyForDevice(press('KeyA', { ctrlKey: true }))).toBeNull();
    expect(keyForDevice(press('Tab', { ctrlKey: true }))).toBeNull();
    expect(keyForDevice(press('F5'))).toBeNull();
    expect(keyForDevice(press('ShiftLeft', { shiftKey: true }))).toBeNull();
  });

  it('checks key steps from the wire', () => {
    expect(isKeySteps([{ usage: 4, down: true }], 16)).toBe(true);
    expect(isKeySteps([], 16)).toBe(false);
    expect(isKeySteps([{ usage: 0, down: true }], 16)).toBe(false);
    expect(isKeySteps([{ usage: 4.5, down: true }], 16)).toBe(false);
    expect(isKeySteps([{ usage: 4, down: 'yes' }], 16)).toBe(false);
    expect(isKeySteps(Array.from({ length: 17 }, () => ({ usage: 4, down: true })), 16)).toBe(false);
  });
});
