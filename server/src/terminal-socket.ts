// One WebSocket's side of the user's terminals. The UI lists a scope's terminals, opens new
// ones, attaches to the tab it shows, and closes tabs. Every message carries the scope key in
// `sessionId` (shared/scope.ts: a session's bare id, `project:<id>` or `group:<id>`) and, for one
// terminal, its terminal id. A session's or project's shells open in its folder; a group has no
// folder, so its shells open in the user's home folder.
//
//   in:  term-list {sessionId}                          -> term-list {sessionId, terminals}
//        term-new {sessionId, cols, rows}               -> term-created {sessionId, terminalId} | term-error {sessionId, message}
//        term-open {sessionId, terminalId, cols, rows, attach?} -> term-data {…, attach, data} (recent output first), term-exit {…, attach, code}
//        term-input {…, data} · term-resize {…, cols, rows} · term-close {…} (stop watching; the shell keeps running)
//        term-kill {…} (close the tab: the shell ends and leaves the list) · term-rename {…, title}
//        term-move {…, target, after} (put the tab before or, with after: true, after tab `target`)
//        term-run {sessionId, lang, text, cols, rows}   -> term-run-started {sessionId, terminalId} | term-run-error {sessionId, message}
//          (run a fenced code block in the scope's Run terminal; refused for a block that is not a shell block)
//        term-run-stop {sessionId} (Ctrl-C to the running block)
//        term-action {sessionId, actionId, cols, rows}  -> term-action-started {sessionId, terminalId, actionId} | term-action-error {sessionId, message}
//          (run one of the project's saved actions in a terminal of its own; the message names it by id and never carries a command)
//          then, for an action with a preview address: term-action-preview {sessionId, actionId, name, url, ready} once it answers, or has not in time
//   out: term-list is also pushed whenever a listed session's terminals change (open, close, exit, title).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { WebSocket } from 'ws';
import { noFolderReason } from './scope-folder.ts';
import { runnableBlock } from './shared/code-run.ts';
import { normalizeScopeKey, parseScope } from './shared/scope.ts';
import { waitForPreview, type PreviewWait, type ResolvedAction } from './saved-actions/run.ts';
import type { TerminalClient, Terminals } from './terminals.ts';
import { Refused } from './workspace.ts';

const MAX_INPUT_CHARS = 100_000;
const MAX_ID_CHARS = 40;
const MAX_TITLE_INPUT_CHARS = 200;

export interface TerminalMessage {
  type: string;
  sessionId: string;
  terminalId?: unknown;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
  title?: unknown;
  attach?: unknown;
  target?: unknown;
  after?: unknown;
  actionId?: unknown;
  lang?: unknown;
  text?: unknown;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a scope's new shell starts: its folder, or the home folder for a group (which has none). */
export async function terminalFolder(key: string, folderOf: (key: string) => Promise<string | null | undefined>, home = homedir()): Promise<string | null> {
  if (parseScope(key)?.kind === 'group') return home;
  return (await folderOf(key).catch(() => null)) ?? null;
}

/** Handle one socket's terminal traffic. Call `close` when the socket closes; the shells keep running. */
/** What running a saved action needs: which one the id names for a scope, and how its preview is waited for. */
export interface ActionRunner {
  resolve(key: string, actionId: string): Promise<ResolvedAction>;
  preview?: PreviewWait;
}

export function terminalSocket(ws: WebSocket, terminals: Terminals, folderOf: (key: string) => Promise<string | null | undefined>, actions?: ActionRunner) {
  // This socket's attachments: terminal id -> the session it belongs to and where its output goes.
  const attached = new Map<string, { sessionId: string; client: TerminalClient }>();
  // Sessions whose terminal list this socket wants pushed when it changes.
  const listed = new Set<string>();
  const say = (payload: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  const sendList = (sessionId: string) => say({ type: 'term-list', sessionId, terminals: terminals.list(sessionId) });
  const stopWatching = terminals.onChange((sessionId) => listed.has(sessionId) && sendList(sessionId));

  async function create(sessionId: string, m: TerminalMessage) {
    const directory = await terminalFolder(sessionId, folderOf);
    if (!directory || !existsSync(directory)) return say({ type: 'term-error', sessionId, message: `${noFolderReason(sessionId)} There is nowhere to open a terminal.` });
    try {
      const info = terminals.open(sessionId, directory, m);
      say({ type: 'term-created', sessionId, terminalId: info.id });
    } catch (error) {
      say({ type: 'term-error', sessionId, message: error instanceof Refused ? error.message : `The terminal could not start: ${errorText(error)}` });
    }
  }

  async function run(sessionId: string, m: TerminalMessage) {
    const fail = (message: string) => say({ type: 'term-run-error', sessionId, message });
    const block = typeof m.text === 'string' && (m.lang === undefined || typeof m.lang === 'string') ? runnableBlock(m.lang as string | undefined, m.text) : null;
    if (!block) return fail('Only shell blocks can be run.');
    const directory = await terminalFolder(sessionId, folderOf);
    if (!directory || !existsSync(directory)) return fail(`${noFolderReason(sessionId)} There is nowhere to run it.`);
    try {
      const terminalId = terminals.run(sessionId, directory, block, m);
      say({ type: 'term-run-started', sessionId, terminalId });
    } catch (error) {
      fail(error instanceof Refused ? error.message : `The run could not start: ${errorText(error)}`);
    }
  }

  /** Ends the waits for preview addresses when the socket closes. */
  const previews = new AbortController();

  async function runAction(sessionId: string, m: TerminalMessage) {
    const fail = (message: string) => say({ type: 'term-action-error', sessionId, message });
    if (!actions || typeof m.actionId !== 'string' || m.actionId.length > MAX_ID_CHARS * 2) return fail('That action cannot be run here.');
    const found = await actions.resolve(sessionId, m.actionId);
    if ('refused' in found) return fail(found.refused);
    const { action, cwd, env } = found;
    try {
      const terminalId = terminals.runAction(sessionId, cwd, action, env, m);
      say({ type: 'term-action-started', sessionId, terminalId, actionId: action.id });
    } catch (error) {
      return fail(error instanceof Refused ? error.message : `${action.name} could not start: ${errorText(error)}`);
    }
    if (!action.previewUrl) return;
    const ready = await waitForPreview(action.previewUrl, { ...actions.preview, signal: previews.signal });
    if (!previews.signal.aborted) say({ type: 'term-action-preview', sessionId, actionId: action.id, name: action.name, url: action.previewUrl, ready });
  }

  function attach(sessionId: string, terminalId: string, m: TerminalMessage) {
    if (attached.has(terminalId)) return;
    // Echoed back so the page can drop output meant for an attachment it has already left.
    const attach = typeof m.attach === 'number' && Number.isSafeInteger(m.attach) ? m.attach : undefined;
    const client: TerminalClient = {
      data: (text) => say({ type: 'term-data', sessionId, terminalId, attach, data: text }),
      exit: (code) => (attached.delete(terminalId), say({ type: 'term-exit', sessionId, terminalId, attach, code })),
    };
    attached.set(terminalId, { sessionId, client });
    if (!terminals.attach(sessionId, terminalId, m, client)) {
      attached.delete(terminalId);
      say({ type: 'term-error', sessionId, terminalId, attach, message: 'This terminal has closed.' });
    }
  }

  function detach(terminalId: string) {
    const entry = attached.get(terminalId);
    attached.delete(terminalId);
    if (entry) terminals.detach(entry.sessionId, terminalId, entry.client);
  }

  /** Handle one message whose type starts with `term-`. */
  function message(m: TerminalMessage): void | Promise<void> {
    const sessionId = normalizeScopeKey(m.sessionId);
    if (!sessionId) return;
    if (m.type === 'term-list') return (listed.add(sessionId), sendList(sessionId), undefined);
    if (m.type === 'term-new') return (listed.add(sessionId), create(sessionId, m));
    if (m.type === 'term-run') return (listed.add(sessionId), run(sessionId, m));
    if (m.type === 'term-run-stop') return terminals.stopRun(sessionId);
    if (m.type === 'term-action') return (listed.add(sessionId), runAction(sessionId, m));
    if (typeof m.terminalId !== 'string' || m.terminalId.length > MAX_ID_CHARS) return;
    const terminalId = m.terminalId;
    const mine = attached.get(terminalId)?.sessionId === sessionId;
    if (m.type === 'term-open') return attach(sessionId, terminalId, m);
    if (m.type === 'term-input') return void (mine && typeof m.data === 'string' && m.data.length <= MAX_INPUT_CHARS && terminals.write(sessionId, terminalId, m.data));
    if (m.type === 'term-resize') return void (mine && terminals.resize(sessionId, terminalId, m));
    if (m.type === 'term-close') return detach(terminalId);
    if (m.type === 'term-kill') return (detach(terminalId), terminals.close(sessionId, terminalId));
    if (m.type === 'term-rename' && typeof m.title === 'string' && m.title.length <= MAX_TITLE_INPUT_CHARS) return terminals.rename(sessionId, terminalId, m.title);
    if (m.type === 'term-move' && typeof m.target === 'string' && m.target.length <= MAX_ID_CHARS) return terminals.move(sessionId, terminalId, m.target, m.after === true);
  }

  function close() {
    previews.abort();
    stopWatching();
    for (const { client } of attached.values()) terminals.forget(client);
    attached.clear();
    listed.clear();
  }

  return { message, close };
}
