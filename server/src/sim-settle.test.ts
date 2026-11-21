import { describe, expect, it } from 'vitest';
import { looksBlank, PictureSettle, SETTLE_LIMIT_MS, STILL_MS, type SettleTimers } from './sim-settle.ts';

/** Timers on a fake clock: `advance(ms)` runs what falls due, in order. */
function clock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: SettleTimers = { set: (fn, ms) => (due.set(++next, { at: now + ms, fn }), next), clear: (h) => void due.delete(h as number) };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const first = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = end;
  };
  return { timers, advance, pending: () => due.size };
}

const size = { width: 100, height: 100 };
const blank = Buffer.alloc(300); // 0.03 bytes per pixel
const drawn = Buffer.alloc(5_000); // 0.5 bytes per pixel
const drawnToo = Buffer.alloc(6_000);
const flush = () => new Promise((r) => setImmediate(r));

describe('waiting for a launched app to draw', () => {
  it('tells a blank screen from a drawn one by how well the picture compresses', () => {
    expect(looksBlank(blank, size)).toBe(true);
    expect(looksBlank(drawn, size)).toBe(false);
    expect(looksBlank(blank)).toBe(false); // size unknown: never call it blank
  });

  it('is ready once a picture is not blank and stays the same for a moment', async () => {
    const { timers, advance } = clock();
    const settle = new PictureSettle(timers);
    let outcome = '';
    void settle.arm().then((o) => (outcome = o));
    settle.frame(blank, size);
    advance(2_000);
    settle.frame(drawn, size);
    advance(STILL_MS - 1);
    settle.frame(drawnToo, size); // still changing: starts the wait again
    advance(STILL_MS - 1);
    await flush();
    expect(outcome).toBe('');
    advance(1);
    await flush();
    expect(outcome).toBe('ready');
  });

  it('ignores pictures from before it was armed', async () => {
    const { timers, advance, pending } = clock();
    const settle = new PictureSettle(timers);
    settle.frame(drawn, size); // the old screen, before the launch
    expect(pending()).toBe(0);
    let outcome = '';
    void settle.arm().then((o) => (outcome = o));
    advance(STILL_MS * 2);
    await flush();
    expect(outcome).toBe('');
  });

  it('gives up after the limit, saying whether the screen was still blank or still changing', async () => {
    const blankRun = clock();
    const a = new PictureSettle(blankRun.timers);
    const stillBlank = a.arm();
    a.frame(blank, size);
    blankRun.advance(SETTLE_LIMIT_MS);
    expect(await stillBlank).toBe('blank');

    const busy = clock();
    const b = new PictureSettle(busy.timers);
    const changing = b.arm();
    for (let t = 0; t < SETTLE_LIMIT_MS; t += 100) {
      b.frame(Buffer.alloc(5_000 + t), size);
      busy.advance(100);
    }
    expect(await changing).toBe('changing');
    expect(busy.pending()).toBe(0);
  });

  it('answers at once when the picture stops, with or without a picture seen', async () => {
    const { timers } = clock();
    const settle = new PictureSettle(timers);
    const none = settle.arm();
    settle.error();
    expect(await none).toBe('no-picture');
  });
});
