// Running a code block from the conversation: the state of a block's Run button, and starting or
// stopping its run. The state lives in the terminal store (what the server lists for the session's
// Run terminal), so it survives the conversation re-rendering and messages remounting.
import { useEffect } from 'react';
import { actions } from './store.ts';
import { terminals, useTerminals } from './terminalStore.ts';

/** Shows a session's Terminal pane; registered by the workspace that shows the session. */
const revealers = new Map<string, () => void>();

/** The workspace showing `sessionId` brings its Terminal pane up when a run starts. Returns the undo. */
export function serveRuns(sessionId: string, reveal: () => void): () => void {
  revealers.set(sessionId, reveal);
  return () => {
    if (revealers.get(sessionId) === reveal) revealers.delete(sessionId);
  };
}

/** Sessions whose terminal list this page has asked for on behalf of code blocks (once each; reconnects ask again). */
const asked = new Set<string>();
function followOnce(sessionId: string): void {
  if (asked.has(sessionId)) return;
  asked.add(sessionId);
  terminals.follow(sessionId);
}

/** What a block's Run button shows: this block running, another one running, or free to run. */
export type BlockRunState = 'running' | 'busy' | 'idle';

/** The run state of the block whose script is `script`, in session `sessionId`. */
export function useBlockRun(sessionId: string, script: string): BlockRunState {
  useEffect(() => followOnce(sessionId), [sessionId]);
  const { terminals: list, starting } = useTerminals(sessionId);
  const running = starting ?? list.find((t) => t.runner && t.running !== null)?.running ?? null;
  if (running === null) return 'idle';
  return running === script ? 'running' : 'busy';
}

/** Run a block in the session's Run terminal, and bring the Terminal pane up once it has started. */
export function runBlock(sessionId: string, block: { lang: string | null; text: string; script: string }): void {
  terminals.follow(sessionId);
  terminals.run(sessionId, block, {
    started: () => revealers.get(sessionId)?.(),
    failed: (message) => actions.showError(message),
  });
}

export const stopRun = (sessionId: string): void => terminals.stopRun(sessionId);
