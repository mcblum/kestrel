// What the UI is told about a session's terminals. Shared so the server and the tab strip agree
// on the shape and on how titles are made.

/** At most this many terminals per session, exited ones included: each one is a tab. */
export const MAX_TERMINALS_PER_SESSION = 8;

export interface TerminalInfo {
  id: string;
  /** What the tab shows: the user's name for it, else the foreground program, numbered when two match. */
  title: string;
  /** True when the user named the tab; it then keeps that name whatever runs in it. */
  renamed: boolean;
  /** Something other than the shell is in the foreground, so closing the tab would cut it off. */
  busy: boolean;
  exited: boolean;
  exitCode: number | null;
  /** The session's Run terminal, where code blocks from the conversation run. */
  runner: boolean;
  /** The block running in the Run terminal now (its script), or null. */
  running: string | null;
}

/** One terminal's own title before numbering. */
export interface TitleSource {
  custom: string | null;
  program: string;
}

/**
 * Titles for a session's terminals in tab order. Automatic titles that would repeat get a number
 * (`zsh`, `zsh 2`); a name the user gave is shown as given.
 */
export function numberTitles(sources: readonly TitleSource[]): string[] {
  const seen = new Map<string, number>();
  return sources.map(({ custom, program }) => {
    const base = custom ?? program;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return custom !== null || count === 1 ? base : `${base} ${count}`;
  });
}

/** Up to this many terminals show as tabs; more and the strip becomes one menu (there is no room to scroll a tab row). */
export const MAX_TERMINAL_TABS = 3;

/** How the strip shows a scope's terminals. */
export const terminalStripMode = (count: number): 'tabs' | 'menu' => (count > MAX_TERMINAL_TABS ? 'menu' : 'tabs');

/** The menu button's words: the current terminal's title and where it is in the list, `zsh · 2 of 5`. */
export function terminalMenuLabel(list: readonly Pick<TerminalInfo, 'id' | 'title'>[], activeId: string | null): string {
  const at = list.findIndex((t) => t.id === activeId);
  if (at === -1) return `${list.length} terminals`;
  return `${list[at]!.title} · ${at + 1} of ${list.length}`;
}

/**
 * The ids after `moving` is dropped beside `target` (before it, or after it). The same list when
 * either is not in it, so a stale drop changes nothing.
 */
export function moveTerminal(ids: readonly string[], moving: string, target: string, after: boolean): string[] {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return [...ids];
  const rest = ids.filter((id) => id !== moving);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}
