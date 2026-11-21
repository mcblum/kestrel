// The user's terminals, per session, as the server lists them; and the byte stream of each one
// a tab is showing. Lists survive the Terminal view closing; the server keeps the shells, so after
// a reload or a reconnect the list is asked for again and attached tabs replay their output.
import { showActionPreview } from './actionPreview.ts';
import { useSyncExternalStore } from 'react';
import { moveTerminal, type TerminalInfo } from '@kestrel/server/terminals';
import { terminalSocket } from './store.ts';

export type { TerminalInfo };

export interface SessionTerminals {
  /** False until the server has answered for this session. */
  listed: boolean;
  terminals: readonly TerminalInfo[];
  /** Why the last new terminal was refused or failed, until the next one opens. */
  error: string | null;
  /** A code block asked to run whose start the server has not confirmed yet (its script). */
  starting: string | null;
  /** The terminal to bring forward (a run started in it); `seq` changes with every request. */
  front: { id: string; seq: number } | null;
}

/** What a tab's screen hears. `replay` comes before output is sent again from the start. */
export type TerminalStream = { type: 'data'; data: string } | { type: 'exit'; code: number } | { type: 'error'; message: string } | { type: 'replay' };

type Size = { cols: number; rows: number };
/** A new Run terminal's size until its screen attaches and fits it. */
const DEFAULT_SIZE: Size = { cols: 100, rows: 30 };
type Incoming = { type: string; sessionId: string } & Record<string, unknown>;

const EMPTY: SessionTerminals = { listed: false, terminals: [], error: null, starting: null, front: null };
let frontSeq = 0;
let sessions: ReadonlyMap<string, SessionTerminals> = new Map();
const listeners = new Set<() => void>();
/** Sessions whose list this page has asked for; asked again on reconnect. */
const followed = new Set<string>();
/**
 * Terminal id -> the tab screen showing it, and the size it last said. Each attachment has its
 * own number, echoed by the server, so output still in flight for one that was left (React
 * mounting twice, or a quick close and reopen) is not written into the next one as well.
 */
const attached = new Map<string, { sessionId: string; size: Size; tag: number; listener: (event: TerminalStream) => void }>();
let nextTag = 1;
/** Callbacks waiting for the id of a terminal this page asked to open, oldest first, per session. */
const pendingCreates = new Map<string, ((terminalId: string) => void)[]>();
/** What to do when the server answers a saved action this page asked to run, per session. */
const pendingActions = new Map<string, { failed: (message: string) => void }>();
/** What to do when the server answers a run this page asked for, per session. */
const pendingRuns = new Map<string, { started: () => void; failed: (message: string) => void }>();

function update(sessionId: string, patch: Partial<SessionTerminals>) {
  const prev = sessions.get(sessionId) ?? EMPTY;
  sessions = new Map(sessions).set(sessionId, { ...prev, ...patch });
  for (const listener of listeners) listener();
}

/** Keep the previous objects for terminals that did not change, so tab rows keep their identity. */
function shareUnchanged(prev: readonly TerminalInfo[], next: readonly TerminalInfo[]): readonly TerminalInfo[] {
  const byId = new Map(prev.map((t) => [t.id, t]));
  const merged = next.map((t) => {
    const old = byId.get(t.id);
    return old && old.title === t.title && old.renamed === t.renamed && old.busy === t.busy && old.exited === t.exited && old.exitCode === t.exitCode && old.runner === t.runner && old.running === t.running ? old : t;
  });
  return merged.length === prev.length && merged.every((t, i) => t === prev[i]) ? prev : merged;
}

function receive(m: Incoming) {
  const { sessionId } = m;
  const terminalId = typeof m.terminalId === 'string' ? m.terminalId : null;
  if (m.type === 'term-list' && Array.isArray(m.terminals)) {
    const prev = sessions.get(sessionId) ?? EMPTY;
    update(sessionId, { listed: true, terminals: shareUnchanged(prev.terminals, m.terminals as TerminalInfo[]) });
  } else if (m.type === 'term-run-started' && terminalId) {
    update(sessionId, { starting: null, front: { id: terminalId, seq: ++frontSeq } });
    pendingRuns.get(sessionId)?.started();
    pendingRuns.delete(sessionId);
  } else if (m.type === 'term-run-error') {
    update(sessionId, { starting: null });
    pendingRuns.get(sessionId)?.failed(String(m.message));
    pendingRuns.delete(sessionId);
  } else if (m.type === 'term-action-started' && terminalId) {
    pendingActions.delete(sessionId);
    update(sessionId, { front: { id: terminalId, seq: ++frontSeq } });
  } else if (m.type === 'term-action-error') {
    pendingActions.get(sessionId)?.failed(String(m.message));
    pendingActions.delete(sessionId);
  } else if (m.type === 'term-action-preview') {
    void showActionPreview(sessionId, { name: String(m.name), url: String(m.url), ready: m.ready === true });
  } else if (m.type === 'term-created' && terminalId) {
    update(sessionId, { error: null });
    pendingCreates.get(sessionId)?.shift()?.(terminalId);
  } else if (m.type === 'term-error' && !terminalId) {
    pendingCreates.get(sessionId)?.shift();
    update(sessionId, { error: String(m.message) });
  } else if (terminalId) {
    const entry = attached.get(terminalId);
    const listener = entry && (m.attach === undefined || m.attach === entry.tag) ? entry.listener : undefined;
    if (m.type === 'term-data') listener?.({ type: 'data', data: String(m.data) });
    else if (m.type === 'term-exit') listener?.({ type: 'exit', code: Number(m.code) });
    else if (m.type === 'term-error') listener?.({ type: 'error', message: String(m.message) });
  }
}

function reopened() {
  for (const sessionId of followed) terminalSocket.send({ type: 'term-list', sessionId });
  for (const [terminalId, entry] of [...attached]) {
    const tag = nextTag++;
    attached.set(terminalId, { ...entry, tag });
    entry.listener({ type: 'replay' });
    terminalSocket.send({ type: 'term-open', sessionId: entry.sessionId, terminalId, attach: tag, ...entry.size });
  }
}

terminalSocket.register({ message: receive, opened: reopened });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** A session's terminals; re-renders only when that session's entry changes. */
export function useTerminals(sessionId: string): SessionTerminals {
  return useSyncExternalStore(subscribe, () => sessions.get(sessionId) ?? EMPTY);
}

export const terminals = {
  /** Ask for the session's list now and whenever the socket comes back. */
  follow(sessionId: string): void {
    followed.add(sessionId);
    terminalSocket.send({ type: 'term-list', sessionId });
  },

  /** Start a new shell. `onCreated` gets its id once the server has it. */
  create(sessionId: string, size: Size, onCreated: (terminalId: string) => void): void {
    followed.add(sessionId);
    if (!terminalSocket.send({ type: 'term-new', sessionId, ...size })) return update(sessionId, { error: 'Not connected to Kestrel. Try again in a moment.' });
    pendingCreates.set(sessionId, [...(pendingCreates.get(sessionId) ?? []), onCreated]);
  },

  /**
   * Run a fenced code block in the session's Run terminal. `started` runs once the server has it
   * going (the terminal is then brought forward); `failed` gets the reason it could not.
   */
  run(sessionId: string, block: { lang: string | null; text: string; script: string }, handlers: { started: () => void; failed: (message: string) => void }): void {
    followed.add(sessionId);
    if (!terminalSocket.send({ type: 'term-run', sessionId, lang: block.lang ?? undefined, text: block.text, ...DEFAULT_SIZE })) return handlers.failed('Not connected to Kestrel. Try again in a moment.');
    pendingRuns.set(sessionId, handlers);
    update(sessionId, { starting: block.script });
  },

  /**
   * Run one of the project's saved actions (by id) in a terminal of its own, which is brought
   * forward once it has started; `failed` gets the reason it could not.
   */
  runAction(sessionId: string, actionId: string, failed: (message: string) => void): void {
    followed.add(sessionId);
    if (!terminalSocket.send({ type: 'term-action', sessionId, actionId, ...DEFAULT_SIZE })) return failed('Not connected to Kestrel. Try again in a moment.');
    pendingActions.set(sessionId, { failed });
  },

  /** Interrupt the session's running block (Ctrl-C). */
  stopRun(sessionId: string): void {
    terminalSocket.send({ type: 'term-run-stop', sessionId });
  },

  /** Show one terminal's output from its recent past on. Returns a function that stops; the shell keeps running. */
  attach(sessionId: string, terminalId: string, size: Size, listener: (event: TerminalStream) => void): () => void {
    const tag = nextTag++;
    attached.set(terminalId, { sessionId, size, tag, listener });
    terminalSocket.send({ type: 'term-open', sessionId, terminalId, attach: tag, ...size });
    return () => {
      if (attached.get(terminalId)?.listener !== listener) return;
      attached.delete(terminalId);
      terminalSocket.send({ type: 'term-close', sessionId, terminalId });
    };
  },

  input(sessionId: string, terminalId: string, data: string): void {
    terminalSocket.send({ type: 'term-input', sessionId, terminalId, data });
  },

  resize(sessionId: string, terminalId: string, size: Size): void {
    const entry = attached.get(terminalId);
    if (entry) attached.set(terminalId, { ...entry, size });
    terminalSocket.send({ type: 'term-resize', sessionId, terminalId, ...size });
  },

  rename(sessionId: string, terminalId: string, title: string): void {
    terminalSocket.send({ type: 'term-rename', sessionId, terminalId, title });
  },

  /** Move a tab before (or after) another. Shown at once; the server's next list confirms it. */
  move(sessionId: string, terminalId: string, targetId: string, after: boolean): void {
    const prev = sessions.get(sessionId);
    if (prev) {
      const order = moveTerminal(prev.terminals.map((t) => t.id), terminalId, targetId, after);
      const byId = new Map(prev.terminals.map((t) => [t.id, t]));
      update(sessionId, { terminals: order.map((id) => byId.get(id)!) });
    }
    terminalSocket.send({ type: 'term-move', sessionId, terminalId, target: targetId, after });
  },

  /** Close the tab: the shell ends and leaves the list. */
  close(sessionId: string, terminalId: string): void {
    attached.delete(terminalId);
    const prev = sessions.get(sessionId);
    // Drop it here at once so the strip does not wait for the server's next list.
    if (prev) update(sessionId, { terminals: prev.terminals.filter((t) => t.id !== terminalId), error: null });
    terminalSocket.send({ type: 'term-kill', sessionId, terminalId });
  },
};
