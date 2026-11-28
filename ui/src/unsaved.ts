// Settings that are typed and then saved (presets and roles, environment, scripts, saved actions,
// limits): each editor registers its draft here, and one Save bar per screen saves or discards
// them together (components/SaveBar.tsx). Leaving a screen with a changed draft asks first
// (`guardLeave`, used by every way a tab's page changes, tabsStore.ts). Not server data: only what
// the user has typed and not saved yet, held by the editor that owns it.
import { useEffect, useId, useRef, useSyncExternalStore, type RefObject } from 'react';

export interface Draft {
  /** What it is, for the leave warning: "Models & roles". */
  what: string;
  changed: boolean;
  /** Why it cannot be saved as it is, or null. */
  problem: string | null;
  /** This draft can still be discarded, but its destination cannot take a save right now. */
  blocked?: boolean;
  /** True when it was stored. */
  save: () => Promise<boolean>;
  /** Back to what is stored. */
  discard: () => void;
}

interface Entry extends Draft {
  /** An element inside the editor: a draft in a section that is not shown does not count for the bar. */
  anchor: RefObject<HTMLElement | null>;
}

export interface DraftsView {
  drafts: readonly Entry[];
  /** The way out that is waiting on the user's answer; null when nobody is leaving. */
  leaving: (() => void) | null;
}

let view: DraftsView = { drafts: [], leaving: null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const emit = (next: Partial<DraftsView> = {}): void => {
  view = { drafts: [...entries.values()], leaving: view.leaving, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

export const useDrafts = (): DraftsView => useSyncExternalStore(subscribe, () => view);
const changedDrafts = (): Entry[] => [...entries.values()].filter((d) => d.changed);

/** Register an editor's draft while it is on the page. The returned ref goes on an element inside the editor. */
export function useDraft(draft: Draft): RefObject<HTMLSpanElement | null> {
  const key = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const before = entries.get(key);
    entries.set(key, { ...draft, anchor });
    // The functions are new each render; only what the bar draws is news.
    if (!before || before.changed !== draft.changed || before.problem !== draft.problem || before.blocked !== draft.blocked || before.what !== draft.what) emit();
  });
  useEffect(() => () => {
    entries.delete(key);
    emit();
  }, [key]);
  return anchor;
}

/** Save every changed draft. False when one could not be saved (it has a problem, or the server refused). */
export async function saveDrafts(): Promise<boolean> {
  for (const draft of changedDrafts()) {
    if (draft.blocked || draft.problem !== null || !(await draft.save())) return false;
  }
  return true;
}

export function discardDrafts(): void {
  for (const draft of changedDrafts()) draft.discard();
}

/** Do `go`, which takes the user off the page in front: at once when nothing is unsaved, else after they answer. */
export function guardLeave(go: () => void): void {
  if (changedDrafts().length === 0) return go();
  emit({ leaving: go });
}

/** The user's answer to the leave warning. */
export const leave = {
  stay: (): void => emit({ leaving: null }),
  discard(): void {
    const go = view.leaving;
    discardDrafts();
    // The drafts are still registered until their editors re-render; they must not stop this way out.
    for (const entry of entries.values()) entry.changed = false;
    emit({ leaving: null });
    go?.();
  },
  async save(): Promise<void> {
    const go = view.leaving;
    const saved = await saveDrafts();
    if (saved) for (const entry of entries.values()) entry.changed = false;
    emit({ leaving: null });
    if (saved) go?.();
  },
};

// Closing the window or reloading the page loses a draft too. A browser asks in its own words; the
// desktop app asks in a dialog of its own (app/main.mjs, `will-prevent-unload`).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (changedDrafts().length === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
