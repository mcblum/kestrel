// The Changes pane's split: the list of changed files above, the chosen file's diff below, each
// scrolling on its own, with a bar between them that is dragged to resize (Matt, 2026-11-24: "the
// entire column scrolls, so I have to scroll up completely to change files"). Pure: how tall the
// list is drawn, from the height the user dragged it to (kept with the other pane sizes in the
// sidebar prefs), the height there is, and how tall the list really is.

/** The list region's height in pixels. */
export const CHANGES_LIST_HEIGHT = {
  /** Two file rows and a little: the list never goes below this. */
  min: 64,
  /** Enough for about six files when nothing was dragged. */
  initial: 200,
  /** Never more than this share of the pane when nothing was dragged. */
  initialShare: 1 / 3,
  /** What is stored is held under this, whatever the window. */
  max: 4000,
} as const;
/** The diff keeps at least this much (its header and a few lines) below the bar. */
export const CHANGES_DIFF_MIN = 140;
/** How far one arrow key moves the bar. */
export const CHANGES_SPLIT_STEP = 24;

const finite = (px: unknown): px is number => typeof px === 'number' && Number.isFinite(px);

/** A dragged height as it is stored: a whole number inside the limits any window could use. */
export const clampChangesListHeight = (px: number): number => Math.round(Math.min(CHANGES_LIST_HEIGHT.max, Math.max(CHANGES_LIST_HEIGHT.min, px)));

/** The most the list may take in a pane `pane` pixels tall (list, bar and diff together). */
export function changesListMax(pane: number): number {
  if (!(pane > 0)) return CHANGES_LIST_HEIGHT.max;
  return Math.max(CHANGES_LIST_HEIGHT.min, Math.round(pane - CHANGES_DIFF_MIN));
}

/** Where the bar goes when nothing was dragged (or after a double-click): the usual height, at most a third of the pane. */
export function changesListDefault(pane: number): number {
  if (!(pane > 0)) return CHANGES_LIST_HEIGHT.initial;
  return Math.max(CHANGES_LIST_HEIGHT.min, Math.min(CHANGES_LIST_HEIGHT.initial, Math.round(pane * CHANGES_LIST_HEIGHT.initialShare)));
}

/** The height the bar stands at: the dragged height (or the default) inside this pane's limits. */
export function changesListTarget(stored: number | undefined, pane: number): number {
  const want = finite(stored) ? stored : changesListDefault(pane);
  return Math.round(Math.min(changesListMax(pane), Math.max(CHANGES_LIST_HEIGHT.min, want)));
}

/**
 * The height the list region is drawn at. A list shorter than where the bar stands (`content`, its
 * rows' real height; 0 before it is measured) takes only what it needs, so no empty space is left
 * above the diff.
 */
export function changesListHeight(stored: number | undefined, pane: number, content: number): number {
  const target = changesListTarget(stored, pane);
  return content > 0 ? Math.min(target, Math.ceil(content)) : target;
}

/** The stored height after the bar moved `dy` pixels from `start` (the height it was drawn at), in a pane `pane` pixels tall. */
export function dragChangesSplit(start: number, dy: number, pane: number): number {
  if (!finite(dy)) return clampChangesListHeight(start);
  return clampChangesListHeight(Math.min(changesListMax(pane), start + dy));
}
