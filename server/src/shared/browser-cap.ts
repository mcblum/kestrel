// How many live browser pages a window keeps. Each scope's browser (a session's, a project or group
// page's) stays alive in the background so an agent can drive it while another page is in front,
// but a page costs memory, so past the cap the one used longest ago is closed. Its address is kept:
// it loads again when its pane is next shown. The page on screen and a page an agent is using
// right now are never closed.

/** Live browser pages a window keeps at most. */
export const LIVE_BROWSER_CAP = 8;

export interface LiveBrowser {
  key: string;
  /** When it was last on screen or driven (any increasing clock). */
  lastUsed: number;
  onScreen: boolean;
  /** An agent's call is running in it. */
  busy: boolean;
}

/** The pages to close so at most `cap` stay, oldest first; fewer when the rest cannot be closed. */
export function browsersToClose(live: readonly LiveBrowser[], cap: number = LIVE_BROWSER_CAP): string[] {
  const excess = live.length - Math.max(0, cap);
  if (excess <= 0) return [];
  return live
    .filter((b) => !b.onScreen && !b.busy)
    .slice()
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, excess)
    .map((b) => b.key);
}
