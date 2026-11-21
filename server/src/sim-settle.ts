// Waiting for a just-launched app to draw: watch the live picture and answer once it is no longer
// blank and has stopped changing, or when time runs out. iOS shows a launching app as a blank page
// for a second or two (seen on iOS 26.5 and 27.2: Settings stayed blank ~2 s), so a fixed pause
// either wastes time or hands the agent an empty screenshot.
import type { FrameViewer } from './sim-frames.ts';

export interface SettleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export type SettleOutcome = 'ready' | 'blank' | 'changing' | 'no-picture';

/** How long the picture must stay the same to count as drawn. */
export const STILL_MS = 700;
/** Give up after this long. */
export const SETTLE_LIMIT_MS = 10_000;
/**
 * A JPEG smaller than this many bytes per pixel is an all-but-empty screen. Measured on the frame
 * helper's JPEGs (iOS 27.2, 402×874): the blank launch page with its status bar ~0.027, Settings
 * drawn ~0.13, the Home Screen ~0.2.
 */
export const BLANK_BYTES_PER_PIXEL = 0.035;

export function looksBlank(jpeg: Buffer, size?: { width: number; height: number }): boolean {
  if (!size || size.width <= 0 || size.height <= 0) return false;
  return jpeg.length / (size.width * size.height) < BLANK_BYTES_PER_PIXEL;
}

/**
 * A frame viewer that, once armed, resolves when a picture that arrived after arming is not blank and
 * nothing new came for STILL_MS. Pictures before arming (the screen as it was) do not count.
 */
export class PictureSettle implements FrameViewer {
  private armed = false;
  private seen = false;
  private blank = true;
  private still: unknown = null;
  private limit: unknown = null;
  private resolve: ((o: SettleOutcome) => void) | null = null;

  constructor(
    private readonly timers: SettleTimers,
    private readonly stillMs = STILL_MS,
    private readonly limitMs = SETTLE_LIMIT_MS,
  ) {}

  frame(jpeg: Buffer, size?: { width: number; height: number }): void {
    if (!this.armed) return;
    this.seen = true;
    this.blank = looksBlank(jpeg, size);
    this.clearStill();
    if (!this.blank) this.still = this.timers.set(() => this.finish('ready'), this.stillMs);
  }

  error(): void {
    this.finish(this.seen ? (this.blank ? 'blank' : 'changing') : 'no-picture');
  }

  /** Start counting from now. */
  arm(): Promise<SettleOutcome> {
    this.armed = true;
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.limit = this.timers.set(() => this.error(), this.limitMs);
    });
  }

  private clearStill(): void {
    if (this.still !== null) this.timers.clear(this.still);
    this.still = null;
  }

  private finish(outcome: SettleOutcome): void {
    this.clearStill();
    if (this.limit !== null) this.timers.clear(this.limit);
    this.limit = null;
    const resolve = this.resolve;
    this.resolve = null;
    this.armed = false;
    resolve?.(outcome);
  }
}
