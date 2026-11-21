// One device's touch helper (`kestrel-sim input`): started on first use, answers one request at a
// time by id, and stopped after a while unused. A request always ends: with the helper's answer,
// a timeout, or the helper going away.
import type { Child, Spawner } from './sim-process.ts';
import { lineReader } from './sim-process.ts';
import { gestureMs, parseCapabilities, type Edge, type KeyStep, type Phase, type SimButton, type SimCapabilities, type SimScreen, type TouchStep } from './shared/simulator.ts';

export interface InputTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export const realInputTimers: InputTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

const READY_MS = 15_000;
/** A request's answer may take this long beyond the time its gesture or typing itself takes. */
const REQUEST_MS = 15_000;
const IDLE_MS = 5 * 60_000;

/** What the helper takes (see the header of app/native/simhelper/Input.swift). Points are device portrait points. */
export type InputRequest =
  | { op: 'touch'; phase: Phase; x: number; y: number; x2?: number; y2?: number; edge?: Edge }
  | { op: 'gesture'; steps: TouchStep[] }
  | { op: 'keys'; steps: (KeyStep & { wait?: number })[] }
  | { op: 'button'; button: SimButton; hold?: number }
  | { op: 'shake' }
  | { op: 'orient'; orientation: number };

export type InputOutcome = { ok: true } | { ok: false; error: string };
export type InputReady = { ok: true; screen: SimScreen; capabilities: SimCapabilities } | { ok: false; error: string };

interface Running {
  child: Child;
  ready: Promise<InputReady>;
}

/** How long a request may take before it counts as lost. */
export function requestBudget(request: InputRequest): number {
  if (request.op === 'gesture' || request.op === 'keys') return REQUEST_MS + gestureMs(request.steps.map((s) => ({ wait: s.wait ?? 0 })));
  if (request.op === 'button') return REQUEST_MS + (request.hold ?? 0);
  return REQUEST_MS;
}

export class InputHelper {
  private running: Running | null = null;
  private next = 1;
  private readonly waiting = new Map<number, (outcome: InputOutcome) => void>();
  private idle: unknown = null;

  constructor(
    private readonly udid: string,
    private readonly helper: () => Promise<{ ok: true; path: string } | { ok: false; reason: string }>,
    private readonly spawn: Spawner,
    private readonly timers: InputTimers = realInputTimers,
  ) {}

  /** The device's portrait screen in points and what its input can do, starting the helper if needed. */
  async screen(): Promise<InputReady> {
    return (await this.start()).ready;
  }

  async send(request: InputRequest): Promise<InputOutcome> {
    const running = await this.start();
    const ready = await running.ready;
    if (!ready.ok) return ready;
    this.touchIdle();
    const id = this.next++;
    return new Promise((resolve) => {
      const budget = requestBudget(request);
      const timer = this.timers.set(() => settle({ ok: false, error: `The simulator did not answer within ${Math.round(budget / 1000)} seconds.` }), budget);
      const settle = (outcome: InputOutcome) => {
        if (!this.waiting.delete(id)) return;
        this.timers.clear(timer);
        resolve(outcome);
      };
      this.waiting.set(id, settle);
      running.child.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  stop(): void {
    const running = this.running;
    this.running = null;
    if (this.idle !== null) this.timers.clear(this.idle);
    this.idle = null;
    running?.child.kill();
    this.failAll('The simulator input stopped.');
  }

  private touchIdle(): void {
    if (this.idle !== null) this.timers.clear(this.idle);
    this.idle = this.timers.set(() => this.stop(), IDLE_MS);
  }

  private failAll(error: string): void {
    for (const settle of [...this.waiting.values()]) settle({ ok: false, error });
  }

  private async start(): Promise<Running> {
    if (this.running) return this.running;
    const helper = await this.helper();
    if (this.running) return this.running;
    if (!helper.ok) return { child: NO_CHILD, ready: Promise.resolve({ ok: false, error: helper.reason }) };
    const child = this.spawn(helper.path, ['input', this.udid]);
    let ready!: (r: Awaited<Running['ready']>) => void;
    const running: Running = { child, ready: new Promise((r) => (ready = r)) };
    this.running = running;
    const timer = this.timers.set(() => ready({ ok: false, error: 'The simulator helper did not start within 15 seconds.' }), READY_MS);
    child.onStdout(
      lineReader((line) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (m.ready === true) {
          this.timers.clear(timer);
          ready({ ok: true, screen: { width: Number(m.width), height: Number(m.height), scale: Number(m.scale) }, capabilities: parseCapabilities(m) });
        } else if (m.ready === false) {
          this.timers.clear(timer);
          ready({ ok: false, error: String(m.error ?? 'The simulator helper could not start.') });
        } else if (typeof m.id === 'number') {
          this.waiting.get(m.id)?.(m.ok === true ? { ok: true } : { ok: false, error: String(m.error ?? 'The simulator could not do that.').slice(0, 500) });
        }
      }),
    );
    child.onExit(() => {
      this.timers.clear(timer);
      ready({ ok: false, error: 'The simulator helper stopped before it was ready.' });
      if (this.running === running) this.running = null;
      this.failAll('The simulator helper stopped.');
    });
    return running;
  }
}

const NO_CHILD: Child = { write: () => undefined, onStdout: () => undefined, onStderr: () => undefined, onExit: () => undefined, kill: () => undefined };
