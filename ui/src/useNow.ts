// The time now, for text that says how long ago something was ("4 days ago"). One clock for every
// row that reads it: it ticks once a minute, and only while something is reading.
import { useSyncExternalStore } from 'react';

const TICK_MS = 60_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The time now, to the minute. */
export const useMinuteNow = (): number => useSyncExternalStore(subscribe, () => now);
