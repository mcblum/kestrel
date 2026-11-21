// Opening a session's Changes pane at one file's diff, from the conversation (an agent's edit line),
// or just the pane, from a session's hover card (showChanges).
// The workspace showing the session brings the pane up (`serveChangesFocus`); the Changes pane
// selects the file once it has it (`useChangesFocus`). UI-only state: which file was asked for last.
import { useSyncExternalStore } from 'react';

export interface ChangesFocus {
  sessionId: string;
  path: string;
  /** A line of the file as it is now, to bring into view and mark in the diff; absent for the file alone. */
  line?: number;
  /** Asked again for the same file: the pane selects it again. */
  seq: number;
}

let current: ChangesFocus | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const revealers = new Map<string, () => void>();
/** Sessions whose Changes pane was asked for before their workspace was showing: brought up when it shows. */
const pending = new Set<string>();

/** The workspace showing `sessionId` brings its Changes pane up when a file is asked for. Returns the undo. */
export function serveChangesFocus(sessionId: string, reveal: () => void): () => void {
  revealers.set(sessionId, reveal);
  if (pending.delete(sessionId)) reveal();
  return () => {
    if (revealers.get(sessionId) === reveal) revealers.delete(sessionId);
  };
}

/** Show `path` (relative to the session's working folder) in the session's Changes pane, at `line` when one is given. */
export function focusChange(sessionId: string, path: string, line?: number): void {
  current = { sessionId, path, ...(line !== undefined ? { line } : {}), seq: ++seq };
  revealers.get(sessionId)?.();
  for (const listener of listeners) listener();
}

/** The latest file asked for in this session, or null. */
export function useChangesFocus(sessionId: string | undefined): ChangesFocus | null {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => (current && current.sessionId === sessionId ? current : null),
  );
}

/** Bring the session's Changes pane up, now or as soon as its workspace shows (opening it is the caller's). */
export function showChanges(sessionId: string): void {
  const reveal = revealers.get(sessionId);
  if (reveal) reveal();
  else pending.add(sessionId);
}
