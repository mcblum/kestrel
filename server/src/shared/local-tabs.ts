// Local tabs inside a page (a project's Sessions and Settings): which one the arrow keys move to, and
// the scroll position each one is left at, so coming back to a tab finds it where it was. Pure.

/** The tab an arrow, Home or End key moves to from `current`; null for any other key. Wraps around. */
export function tabForKey<T extends string>(tabs: readonly T[], current: T, key: string): T | null {
  const i = tabs.indexOf(current);
  if (i < 0 || tabs.length === 0) return null;
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length]!;
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length]!;
  if (key === 'Home') return tabs[0]!;
  if (key === 'End') return tabs[tabs.length - 1]!;
  return null;
}

export type ScrollMemory = Readonly<Record<string, number>>;

/** The memory with `tab` last seen at `scrollTop` (kept as the page scrolls, however the tab is left). */
export function rememberScroll(memory: ScrollMemory, tab: string, scrollTop: number): ScrollMemory {
  const top = Math.max(0, Math.round(scrollTop));
  return memory[tab] === top ? memory : { ...memory, [tab]: top };
}

/** Where `tab` should be scrolled when shown again: where it was left, or the top the first time. */
export const scrollFor = (memory: ScrollMemory, tab: string): number => memory[tab] ?? 0;
