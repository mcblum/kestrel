// What was copied last, so a button that opened a copy menu can show a tick like CopyButton does.
// One key at a time; it is forgotten after a moment.
import { useEffect, useState, useSyncExternalStore } from 'react';

const SHOW_MS = 1200;
let current: { key: string; n: number } | null = null;
const listeners = new Set<() => void>();

export function markCopied(key: string): void {
  current = { key, n: (current?.n ?? 0) + 1 };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** True for a moment after something was copied under `key`. */
export function useCopied(key: string): boolean {
  const latest = useSyncExternalStore(subscribe, () => current);
  const [shown, setShown] = useState<number | null>(null);
  const n = latest?.key === key ? latest.n : null;
  useEffect(() => {
    if (n === null) return;
    setShown(n);
    const timer = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [n]);
  return shown !== null && shown === n;
}
