// Which sidebar row's hover card is shown (a project's, ProjectCard.tsx, or a session's,
// SessionCard.tsx), and the timers around it. One card at a time, like the context menu
// (menuState.ts). It opens after the pointer rests on a row, stays while the pointer is on the row
// or the card, and goes shortly after it leaves both. Never during a drag or with a button pressed.
import { useSyncExternalStore, type PointerEvent } from 'react';
import type { Rect } from '@kestrel/server/popup-place';

/** How long the pointer rests on a row before its card shows. */
export const CARD_OPEN_DELAY_MS = 500;
/** How long the card waits after the pointer leaves the row and the card, so it can cross the gap. */
export const CARD_CLOSE_DELAY_MS = 180;
/** The gap between the sidebar's right edge and the card. */
export const CARD_GAP = 6;
/**
 * How far above its row the card starts, so a pointer drifting upward on its way across still
 * lands on the card (Matt, 2026-11-19).
 */
export const CARD_LIFT = 10;
/**
 * With a card up, how long the pointer must rest on ANOTHER row before the card changes to that
 * row's: a pointer heading down to a lower line of the card crosses the rows in between.
 */
export const CARD_SWITCH_DELAY_MS = 160;

export type CardKind = 'project' | 'session';

/** Which row's card: its kind and id, and for a session what the sidebar's tree says of its lineage. */
export interface CardTarget {
  kind: CardKind;
  id: string;
  /**
   * "Handed off from X", "Part of X", "Delegated to 2 sessions": only the tree knows it. With the
   * session it names, when it names one, so the card can open it.
   */
  lineage?: { text: string; sessionId?: string } | null;
}

export interface CardAt extends CardTarget {
  /**
   * What the card sits beside: the row's height across the sidebar's width, in window
   * coordinates. The card opens to its right, level with the row, kept inside the window.
   */
  anchor: Rect;
}

let current: CardAt | null = null;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let dragging = false;
const listeners = new Set<() => void>();

const set = (next: CardAt | null) => {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
};
const stopTimers = () => (clearTimeout(openTimer), clearTimeout(closeTimer));

function show(target: CardTarget, row: HTMLElement): void {
  if (dragging || !row.isConnected) return;
  const box = row.getBoundingClientRect();
  const side = row.closest('.studio-sidebar')?.getBoundingClientRect();
  set({ ...target, anchor: { left: side?.left ?? box.left, right: side?.right ?? box.right, top: box.top - CARD_LIFT, bottom: box.bottom } });
}

export const hoverCard = {
  close: () => (stopTimers(), set(null)),
  /** The pointer reached a row: show its card after the delay, or at once if a card is up. */
  enterRow(target: CardTarget, row: HTMLElement): void {
    stopTimers();
    if (dragging) return;
    // The same row again (back from the gap): nothing to change.
    if (current && current.kind === target.kind && current.id === target.id) return;
    openTimer = setTimeout(() => show(target, row), current ? CARD_SWITCH_DELAY_MS : CARD_OPEN_DELAY_MS);
  },
  /** The pointer left the row or the card. */
  leave(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => set(null), CARD_CLOSE_DELAY_MS);
  },
  /** The pointer is on the card: keep it, and forget a row it crossed on the way. */
  enterCard: () => stopTimers(),
  /** A drag started or ended anywhere: no card during a drag. */
  setDragging(on: boolean): void {
    dragging = on;
    if (on) hoverCard.close();
  },
};

export const useHoverCard = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current);

/** The pointer handlers for a row (a pressed button means a drag or a click: no card). */
export function cardTrigger(target: CardTarget) {
  return {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => event.buttons === 0 && hoverCard.enterRow(target, event.currentTarget),
    onPointerLeave: () => hoverCard.leave(),
  };
}
