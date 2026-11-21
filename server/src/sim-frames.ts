// One device's live picture: the `kestrel-sim frames` helper runs while at least one viewer
// watches, and stops when the last one leaves. The helper only sends a picture when the screen was
// redrawn; on top of that, after a few quiet seconds the check rate drops, and the first change
// brings it back. Pictures are JPEG; identical ones are dropped.
import type { Child, Spawner } from './sim-process.ts';
import { lineReader } from './sim-process.ts';
import type { Orientation } from './shared/simulator.ts';

export interface FrameTimers {
  every(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export const realFrameTimers: FrameTimers = {
  every: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearInterval(h as NodeJS.Timeout),
  now: () => Date.now(),
};

/** Checks per second while the screen changes, and after it has been still for QUIET_MS. */
export const BUSY_FPS = 12;
export const QUIET_FPS = 3;
export const QUIET_MS = 3_000;
const CHECK_MS = 1_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_WIDTH = 800;

export interface FrameViewer {
  /** A new picture; `size` is its width and height in pixels when known. */
  frame(jpeg: Buffer, size?: { width: number; height: number }): void;
  /** The picture stopped: the helper failed or the device went away. */
  error(reason: string): void;
}

interface Viewer {
  sink: FrameViewer;
  maxWidth: number;
}

export class FrameSource {
  private readonly viewers = new Set<Viewer>();
  private child: Child | null = null;
  private last: Buffer | null = null;
  private lastSize: { width: number; height: number } | undefined;
  private pending: Buffer = Buffer.alloc(0);
  private fps = BUSY_FPS;
  private lastChange = 0;
  private check: unknown = null;
  private sentWidth = 0;

  constructor(
    private readonly udid: string,
    private readonly helper: () => Promise<{ ok: true; path: string } | { ok: false; reason: string }>,
    private readonly spawn: Spawner,
    private orientation: Orientation,
    private readonly timers: FrameTimers = realFrameTimers,
  ) {}

  get watching(): number {
    return this.viewers.size;
  }

  get rate(): number {
    return this.fps;
  }

  /** Start watching; returns the function that stops. The newest picture comes at once if there is one. */
  subscribe(sink: FrameViewer, maxWidth = DEFAULT_WIDTH): () => void {
    const viewer: Viewer = { sink, maxWidth: clampWidth(maxWidth) };
    this.viewers.add(viewer);
    if (this.last) sink.frame(this.last, this.lastSize);
    if (this.child) {
      this.sendWidth();
      this.child.write('{"op":"frame"}\n');
    } else if (this.viewers.size === 1) void this.start();
    return () => {
      if (!this.viewers.delete(viewer)) return;
      if (this.viewers.size === 0) this.stop();
      else this.sendWidth();
    };
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation;
    this.last = null;
    this.child?.write(`${JSON.stringify({ orientation })}\n`);
  }

  /** Stop the helper whatever is watching (the device shut down). */
  close(reason: string): void {
    const viewers = [...this.viewers];
    this.viewers.clear();
    this.stop();
    for (const v of viewers) v.sink.error(reason);
  }

  private async start(): Promise<void> {
    const helper = await this.helper();
    if (this.viewers.size === 0 || this.child) return;
    if (!helper.ok) return this.close(helper.reason);
    const child = this.spawn(helper.path, ['frames', this.udid]);
    this.child = child;
    this.pending = Buffer.alloc(0);
    this.fps = BUSY_FPS;
    this.lastChange = this.timers.now();
    this.sentWidth = 0;
    let said = '';
    child.onStderr(
      lineReader((line) => {
        try {
          const m = JSON.parse(line) as { ready?: boolean; error?: string };
          if (m.ready === false || (m.error && !m.ready)) said = m.error ?? said;
        } catch {
          // not ours
        }
      }),
    );
    child.onStdout((chunk) => this.receive(chunk));
    child.onExit((code) => {
      if (this.child !== child) return;
      this.child = null;
      this.stopCheck();
      if (this.viewers.size) this.close(said || `The simulator's picture stopped (helper exited with ${code ?? 'a signal'}).`);
    });
    child.write(`${JSON.stringify({ fps: this.fps, maxWidth: this.width(), orientation: this.orientation })}\n`);
    this.sentWidth = this.width();
    this.check = this.timers.every(() => this.pace(), CHECK_MS);
  }

  private stop(): void {
    this.stopCheck();
    const child = this.child;
    this.child = null;
    this.last = null;
    child?.kill();
  }

  private stopCheck(): void {
    if (this.check !== null) this.timers.clear(this.check);
    this.check = null;
  }

  private width(): number {
    return Math.max(...[...this.viewers].map((v) => v.maxWidth), 100);
  }

  private sendWidth(): void {
    const width = this.width();
    if (!this.child || width === this.sentWidth) return;
    this.sentWidth = width;
    this.child.write(`${JSON.stringify({ maxWidth: width })}\n`);
  }

  /** Slow down after a quiet spell. */
  private pace(): void {
    if (this.fps !== QUIET_FPS && this.timers.now() - this.lastChange >= QUIET_MS) this.setFps(QUIET_FPS);
  }

  private setFps(fps: number): void {
    this.fps = fps;
    this.child?.write(`${JSON.stringify({ fps })}\n`);
  }

  /** Records: u32 length, u16 width, u16 height, JPEG. */
  private receive(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const length = this.pending.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) return this.close('The simulator helper sent a picture Kestrel could not read.');
      if (this.pending.length < 8 + length) return;
      const size = { width: this.pending.readUInt16BE(4), height: this.pending.readUInt16BE(6) };
      const jpeg = Buffer.from(this.pending.subarray(8, 8 + length));
      this.pending = this.pending.subarray(8 + length);
      this.deliver(jpeg, size);
    }
  }

  private deliver(jpeg: Buffer, size: { width: number; height: number }): void {
    if (this.last && this.last.equals(jpeg)) return;
    this.last = jpeg;
    this.lastSize = size;
    this.lastChange = this.timers.now();
    if (this.fps !== BUSY_FPS) this.setFps(BUSY_FPS);
    for (const v of this.viewers) v.sink.frame(jpeg, size);
  }
}

const clampWidth = (w: number) => (Number.isFinite(w) ? Math.min(2400, Math.max(100, Math.round(w))) : DEFAULT_WIDTH);
