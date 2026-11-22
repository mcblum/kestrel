// Keep awake while agents work (shared/keep-awake.ts, keep-awake/*): the rule, reading the
// battery, and holding and releasing as sessions start and stop working.
import { describe, expect, it, test, vi } from 'vitest';
import { keepAwakeRoute } from './keep-awake/api.ts';
import { awakeMeans, KeepAwake } from './keep-awake/hold.ts';
import { awakeState, awakeText, ON_MAINS, parseLinuxPower, parsePower, sanitizeKeepAwake, UNAVAILABLE_ON_LINUX, UNAVAILABLE_ON_WINDOWS, type Power } from './shared/keep-awake.ts';

const MAINS: Power = { onBattery: false, percent: 100 };
const battery = (percent: number): Power => ({ onBattery: true, percent });

describe('the rule', () => {
  it('holds only when it is on, something is working, and the battery is not low', () => {
    expect(awakeState({ enabled: false }, true, MAINS)).toEqual({ holding: false, why: 'off' });
    expect(awakeState({ enabled: true }, false, MAINS)).toEqual({ holding: false, why: 'idle' });
    expect(awakeState({ enabled: true }, true, MAINS)).toEqual({ holding: true });
    expect(awakeState({ enabled: true }, true, battery(20))).toEqual({ holding: true });
    expect(awakeState({ enabled: true }, true, battery(19))).toEqual({ holding: false, why: 'low-battery' });
    expect(awakeState({ enabled: true }, true, { onBattery: false, percent: 5 })).toEqual({ holding: true }); // charging
    expect(awakeState({ enabled: true }, true, MAINS, false)).toEqual({ holding: false, why: 'unavailable' });
  });

  it('says what it is doing in words', () => {
    expect(awakeText({ holding: true }, MAINS)).toBe('An agent is working: this Mac is being kept awake.');
    expect(awakeText({ holding: false, why: 'low-battery' }, battery(12))).toBe('The battery is at 12%, below 20%, so this Mac is left to sleep.');
    expect(awakeText({ holding: false, why: 'off' }, MAINS)).toBe('');
  });

  it('reads pmset’s report, and is off unless stored as on', () => {
    expect(parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t34%; discharging; 0:44 remaining present: true")).toEqual({ onBattery: true, percent: 34 });
    expect(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true")).toEqual({ onBattery: false, percent: 100 });
    expect(parsePower("Now drawing from 'AC Power'\n")).toEqual({ onBattery: false, percent: null });
    expect(sanitizeKeepAwake({ enabled: 'yes' })).toEqual({ enabled: false });
  });
});

describe('holding the Mac awake', () => {
  function world() {
    const w = { working: false, power: MAINS, holds: 0, releases: 0 };
    const keep = new KeepAwake({ working: async () => w.working, power: async () => w.power, hold: () => (w.holds++, { release: () => void w.releases++ }), available: true, recheckMs: 3_600_000 });
    return { w, keep };
  }

  it('does nothing until it is turned on', async () => {
    const { w, keep } = world();
    w.working = true;
    expect(await keep.refresh()).toMatchObject({ enabled: false, state: { holding: false, why: 'off' } });
    expect(w.holds).toBe(0);
  });

  it('holds once while agents work and releases when none does', async () => {
    const { w, keep } = world();
    await keep.set(true);
    w.working = true;
    expect((await keep.refresh()).state).toEqual({ holding: true });
    await keep.refresh();
    expect([w.holds, w.releases]).toEqual([1, 0]);
    w.working = false;
    expect((await keep.refresh()).state).toEqual({ holding: false, why: 'idle' });
    expect([w.holds, w.releases]).toEqual([1, 1]);
    keep.stop();
  });

  it('lets go when the battery runs low, when it is turned off, and when Kestrel stops', async () => {
    const { w, keep } = world();
    await keep.set(true);
    w.working = true;
    await keep.refresh();
    w.power = battery(10);
    expect((await keep.refresh()).state).toEqual({ holding: false, why: 'low-battery' });
    expect(w.releases).toBe(1);
    w.power = MAINS;
    await keep.refresh();
    expect((await keep.set(false)).state).toEqual({ holding: false, why: 'off' });
    expect(w.releases).toBe(2);
    await keep.set(true);
    keep.stop();
    expect([w.holds, w.releases]).toEqual([3, 3]);
  });

  it('is served and switched over HTTP', async () => {
    const { w, keep } = world();
    w.working = true;
    const route = (method: string, body: Record<string, unknown> = {}) => keepAwakeRoute(['api', 'keep-awake'], method, async () => body, keep);
    expect(await route('GET')).toMatchObject({ status: 200, body: { enabled: false } });
    expect(await route('PUT', { enabled: 'yes' })).toEqual({ status: 400, body: { error: 'enabled must be true or false.' } });
    expect(await route('PUT', { enabled: true })).toMatchObject({ status: 200, body: { enabled: true, state: { holding: true } } });
    expect(await keepAwakeRoute(['api', 'other'], 'GET', async () => ({}), keep)).toBeNull();
    keep.stop();
  });
});

describe('keep awake off a Mac', () => {
  const has = (...programs: string[]) => (program: string) => programs.includes(program);

  test('a Mac and a Linux with systemd-inhibit can be held; the words name the computer', () => {
    expect('hold' in awakeMeans('mac', has())).toBe(true);
    expect('hold' in awakeMeans('linux', has('systemd-inhibit'))).toBe(true);
    expect(awakeText({ holding: true }, ON_MAINS, 'this computer')).toBe('An agent is working: this computer is being kept awake.');
    expect(awakeText({ holding: false, why: 'idle' }, ON_MAINS, 'this computer')).toBe('No agent is working, so this computer may sleep as usual.');
  });

  test('Windows, and a Linux without systemd-inhibit, say why they cannot', () => {
    expect(awakeMeans('windows', has('systemd-inhibit'))).toEqual({ unavailable: UNAVAILABLE_ON_WINDOWS });
    expect(awakeMeans('linux', has())).toEqual({ unavailable: UNAVAILABLE_ON_LINUX });
    expect(awakeText({ holding: false, why: 'unavailable' }, ON_MAINS, 'this computer', UNAVAILABLE_ON_WINDOWS)).toBe(UNAVAILABLE_ON_WINDOWS);
  });

  test('the view carries the reason, and nothing is held or asked of the agents', async () => {
    const hold = vi.fn(() => ({ release: () => undefined }));
    const working = vi.fn(async () => true);
    const awake = new KeepAwake({ working, hold, platform: 'windows' });
    const view = await awake.set(true);
    expect(view).toMatchObject({ enabled: true, state: { holding: false, why: 'unavailable' }, computer: 'this computer', unavailable: UNAVAILABLE_ON_WINDOWS });
    expect(hold).not.toHaveBeenCalled();
    expect(working).not.toHaveBeenCalled();
  });

  test('a Linux battery is read from its status and capacity files', () => {
    expect(parseLinuxPower('Discharging\n', '17\n')).toEqual({ onBattery: true, percent: 17 });
    expect(parseLinuxPower('Charging\n', '80\n')).toEqual({ onBattery: false, percent: 80 });
    expect(parseLinuxPower(null, null)).toEqual({ onBattery: false, percent: null });
  });
});
