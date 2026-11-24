// The user's own interactive shells for a session, in that session's working folder. A session
// can have several (one per tab in its Terminal view), each kept running while the server is up,
// so leaving and coming back finds the same shells with their recent output. This is the
// user's shell, not the agent's: nothing here is offered to an agent.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { discardRun, prepareRun, type PreparedRun } from './code-run.ts';
import { hostPlatform, terminalShell } from './host.ts';
import { RUN_TERMINAL_TITLE, scanRunEnd, type RunnableBlock } from './shared/code-run.ts';
import { MAX_TERMINALS_PER_SESSION, moveTerminal, numberTitles, type TerminalInfo } from './shared/terminals.ts';
import type { Platform } from './shared/platform.ts';
import { Refused } from './workspace.ts';

/** The part of node-pty used here, so tests can stand in for it. */
export interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** The foreground program's name (node-pty's `process`). */
  readonly process?: string;
}
export type SpawnPty = (shell: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => Pty;

export interface TerminalClient {
  data(text: string): void;
  exit(code: number): void;
}

export interface TerminalOptions {
  /** How often, at most, output makes the server ask which program is in front. 0 = every time. */
  titleCheckMs?: number;
  /** How often the program in front is also checked while someone watches the terminal, so a quiet
   *  command (`sleep 300`) still shows in the title. 0 = never. */
  titlePollMs?: number;
  /** Which kind of computer this is (host.ts); tests name one. */
  platform?: Platform;
}

/** About 200 KB of recent output per terminal, replayed to a client that attaches. */
const SCROLLBACK_CHARS = 200_000;
/** When trimming cuts a line, drop the rest of it (up to this much) so replay starts on a fresh line. */
const TRIM_TO_LINE_CHARS = 4_000;
const TITLE_CHECK_MS = 250;
const TITLE_POLL_MS = 1000;
const MAX_TITLE_CHARS = 60;
const clampSize = (n: unknown, fallback: number, max: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(2, Math.min(max, Math.floor(n))) : fallback);
const sizeOf = (size: { cols?: unknown; rows?: unknown }) => ({ cols: clampSize(size.cols, 100, 500), rows: clampSize(size.rows, 30, 300) });

/** The environment for the user's shell: theirs, without what Kestrel and Electron added for the server. */
export function terminalEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith('KESTREL_') || key.startsWith('ELECTRON_')) continue;
    out[key] = value;
  }
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

/** node-pty's real spawn. Its prebuilt helper can arrive without its execute bit; set it once. */
export function nodePtySpawn(): SpawnPty {
  const require = createRequire(import.meta.url);
  const pty = require('node-pty') as { spawn: (file: string, args: string[], options: object) => Pty };
  const helper = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  return (shell, args, options) => pty.spawn(shell, args, { name: 'xterm-256color', ...options });
}

/** A line Kestrel writes at the top of a terminal, dimmed so it reads as Kestrel's and not the shell's. */
export const noticeLine = (text: string): string => `\x1b[2m[Kestrel] ${text.replace(/[\r\n\x1b]+/g, ' ')}\x1b[0m\r\n`;

/** Recent output, kept as chunks so a busy shell does not copy the whole buffer on every write. */
export class Scrollback {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly limit = SCROLLBACK_CHARS) {}

  add(data: string): void {
    this.chunks.push(data);
    this.length += data.length;
    while (this.chunks.length > 1 && this.length - this.chunks[0]!.length >= this.limit) this.length -= this.chunks.shift()!.length;
    if (this.length <= this.limit) return;
    const first = this.chunks[0]!;
    const cut = first.slice(this.length - this.limit);
    const newline = cut.indexOf('\n');
    const trimmed = newline >= 0 && newline < TRIM_TO_LINE_CHARS ? cut.slice(newline + 1) : cut;
    this.length += trimmed.length - first.length;
    this.chunks[0] = trimmed;
  }

  text(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }
}

interface Running {
  id: string;
  pty: Pty;
  shellName: string;
  scrollback: Scrollback;
  clients: Set<TerminalClient>;
  /** The user's name for the tab, or null for the automatic one. */
  custom: string | null;
  program: string;
  lastTitleCheck: number;
  titleTimer: NodeJS.Timeout | null;
  /** The periodic check, running only while a client is attached. */
  poll: NodeJS.Timeout | null;
  exitCode: number | null;
  /** The session's Run terminal, where code blocks from the conversation run. */
  runner: boolean;
  /** The block running in it now, until its end marker arrives. */
  run: (PreparedRun & { script: string; carry: string }) | null;
  /** The saved action this terminal was opened for (shared/saved-actions.ts), if any. */
  actionId?: string;
}

export class Terminals {
  /** Session id -> its terminals, in the order they were opened (tab order). */
  private readonly sessions = new Map<string, Running[]>();
  private readonly listeners = new Set<(sessionId: string) => void>();
  private spawnPty: SpawnPty | null;
  private readonly titleCheckMs: number;
  private readonly titlePollMs: number;
  private readonly platform: Platform;

  constructor(
    spawnPty: SpawnPty | null = null,
    private readonly env: Record<string, string | undefined> = process.env,
    options: TerminalOptions = {},
  ) {
    this.spawnPty = spawnPty;
    this.titleCheckMs = options.titleCheckMs ?? TITLE_CHECK_MS;
    this.titlePollMs = options.titlePollMs ?? TITLE_POLL_MS;
    this.platform = options.platform ?? hostPlatform();
  }

  /** Called with a session id whenever its list of terminals, a title or an exit changes. */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The session's terminals as the tab strip shows them. */
  list(sessionId: string): TerminalInfo[] {
    const terms = this.sessions.get(sessionId) ?? [];
    const titles = numberTitles(terms.map((t) => ({ custom: t.custom, program: t.program })));
    return terms.map((t, i) => ({
      id: t.id,
      title: titles[i]!,
      renamed: t.custom !== null,
      busy: t.exitCode === null && t.program !== t.shellName,
      exited: t.exitCode !== null,
      exitCode: t.exitCode,
      runner: t.runner,
      running: t.run?.script ?? null,
    }));
  }

  /**
   * Start a new login shell for the session in `cwd`. Refused past the per-session cap. `notice`, when
   * given, is the terminal's first line, dimmed: why it opened somewhere other than the session's worktree.
   */
  open(sessionId: string, cwd: string, size: { cols?: unknown; rows?: unknown }, notice?: string | null): TerminalInfo {
    const term = this.start(sessionId, cwd, size, false);
    if (notice) term.scrollback.add(noticeLine(notice));
    return this.list(sessionId).find((t) => t.id === term.id)!;
  }

  /**
   * Run a code block in the session's Run terminal (opened, or opened again, as needed), in `cwd`.
   * Refused while a block is already running there or the user has a program in front in it.
   * Returns the Run terminal's id. The end is known from the wrapper's marker, not from timing.
   */
  run(sessionId: string, cwd: string, block: RunnableBlock, size: { cols?: unknown; rows?: unknown }): string {
    // The run's wrapper is a POSIX shell script, typed into the Run terminal's shell (code-run.ts).
    if (this.platform === 'windows') throw new Refused('Running a code block is not available on Windows yet: it is run by a POSIX shell script, and the terminal here is PowerShell. Copy it into the terminal instead.');
    let term = this.sessions.get(sessionId)?.find((t) => t.runner);
    if (term?.run) throw new Refused('A run is already in progress. Stop it or wait for it to finish.');
    if (term && term.exitCode !== null) {
      this.close(sessionId, term.id);
      term = undefined;
    }
    term ??= this.start(sessionId, cwd, size, true);
    const program = programName(term);
    if (program !== term.shellName) throw new Refused(`The Run terminal is busy with ${program}. Finish it there first.`);
    const prepared = prepareRun(cwd, block);
    term.run = { ...prepared, script: block.script, carry: '' };
    term.pty.write(prepared.commandLine);
    this.changed(sessionId);
    return term.id;
  }

  /**
   * Run a saved action (shared/saved-actions.ts) in a terminal of its own, named after it, in `cwd`
   * with `env` added to the shell's. Refused while the action is still running in its terminal; one
   * whose shell is free (or has exited) is replaced by a new one, so every run starts in the
   * action's folder with the variables as they now are. Returns the terminal's id.
   */
  runAction(sessionId: string, cwd: string, action: { id: string; name: string; command: string }, env: Record<string, string>, size: { cols?: unknown; rows?: unknown }): string {
    const old = this.sessions.get(sessionId)?.find((t) => t.actionId === action.id);
    if (old && old.exitCode === null && programName(old) !== old.shellName) throw new Refused(`${action.name} is already running. Stop it in its terminal first.`);
    if (old) this.close(sessionId, old.id);
    const term = this.start(sessionId, cwd, size, false, { env, title: action.name, actionId: action.id });
    term.pty.write(`${action.command}\r`);
    this.changed(sessionId);
    return term.id;
  }

  /** Interrupt the running block, as Ctrl-C would. Nothing happens when nothing runs. */
  stopRun(sessionId: string): void {
    const term = this.sessions.get(sessionId)?.find((t) => t.runner);
    if (term?.run && term.exitCode === null) term.pty.write('\x03');
  }

  private start(sessionId: string, cwd: string, size: { cols?: unknown; rows?: unknown }, runner: boolean, action?: { env: Record<string, string>; title: string; actionId: string }): Running {
    const terms = this.sessions.get(sessionId) ?? [];
    if (terms.length >= MAX_TERMINALS_PER_SESSION) throw new Refused(`A session, project or group page can have at most ${MAX_TERMINALS_PER_SESSION} terminals. Close one to open another.`);
    this.spawnPty ??= nodePtySpawn();
    const env = { ...terminalEnv(this.env), ...action?.env };
    const { file: shell, args } = terminalShell(env, this.platform);
    const pty = this.spawnPty(shell, args, { cwd, ...sizeOf(size), env });
    const shellName = basename(shell);
    const term: Running = { id: randomUUID().slice(0, 8), pty, shellName, scrollback: new Scrollback(), clients: new Set(), custom: runner ? RUN_TERMINAL_TITLE : (action?.title ?? null), program: shellName, lastTitleCheck: 0, titleTimer: null, poll: null, exitCode: null, runner, run: null, ...(action ? { actionId: action.actionId } : {}) };
    this.sessions.set(sessionId, [...terms, term]);
    pty.onData((data) => {
      term.scrollback.add(data);
      for (const c of term.clients) c.data(data);
      this.checkRunEnd(sessionId, term, data);
      this.checkTitle(sessionId, term);
    });
    pty.onExit(({ exitCode }) => this.exited(sessionId, term, exitCode));
    this.changed(sessionId);
    return term;
  }

  /** The running block's wrapper printed its end marker: the run is over. */
  private checkRunEnd(sessionId: string, term: Running, data: string): void {
    if (!term.run) return;
    const { code, carry } = scanRunEnd(term.run.carry, data, term.run.nonce);
    if (code === null) return void (term.run.carry = carry);
    term.run = null;
    this.changed(sessionId);
  }

  /** A run's shell went away before the block ended: forget the run and its files. */
  private dropRun(term: Running): void {
    if (!term.run) return;
    discardRun(term.run.dir);
    term.run = null;
  }

  /** Attach a client to one terminal: its recent output first, then what follows. False if there is no such terminal. */
  attach(sessionId: string, terminalId: string, size: { cols?: unknown; rows?: unknown }, client: TerminalClient): boolean {
    const term = this.find(sessionId, terminalId);
    if (!term) return false;
    const replay = term.scrollback.text();
    if (replay) client.data(replay);
    if (term.exitCode !== null) {
      client.exit(term.exitCode);
      return true;
    }
    const { cols, rows } = sizeOf(size);
    term.pty.resize(cols, rows);
    term.clients.add(client);
    this.watched(sessionId, term);
    return true;
  }

  detach(sessionId: string, terminalId: string, client: TerminalClient): void {
    const term = this.find(sessionId, terminalId);
    term?.clients.delete(client);
    if (term) this.watched(sessionId, term);
  }

  /** Drop a client from every shell (its socket closed). The shells keep running. */
  forget(client: TerminalClient): void {
    for (const [sessionId, terms] of this.sessions)
      for (const term of terms) if (term.clients.delete(client)) this.watched(sessionId, term);
  }

  write(sessionId: string, terminalId: string, data: string): void {
    const term = this.find(sessionId, terminalId);
    if (term && term.exitCode === null) term.pty.write(data);
  }

  resize(sessionId: string, terminalId: string, size: { cols?: unknown; rows?: unknown }): void {
    const term = this.find(sessionId, terminalId);
    if (!term || term.exitCode !== null) return;
    const { cols, rows } = sizeOf(size);
    term.pty.resize(cols, rows);
  }

  /** Name a tab. An empty name goes back to the automatic title. */
  rename(sessionId: string, terminalId: string, title: string): void {
    const term = this.find(sessionId, terminalId);
    if (!term) return;
    const name = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
    term.custom = name || null;
    this.changed(sessionId);
  }

  /** Move a tab beside another (before it, or after it). Unknown ids change nothing. */
  move(sessionId: string, terminalId: string, targetId: string, after: boolean): void {
    const terms = this.sessions.get(sessionId);
    if (!terms) return;
    const order = moveTerminal(terms.map((t) => t.id), terminalId, targetId, after);
    if (order.every((id, i) => id === terms[i]!.id)) return;
    const byId = new Map(terms.map((t) => [t.id, t]));
    this.sessions.set(sessionId, order.map((id) => byId.get(id)!));
    this.changed(sessionId);
  }

  has(sessionId: string, terminalId?: string): boolean {
    return terminalId === undefined ? (this.sessions.get(sessionId)?.length ?? 0) > 0 : Boolean(this.find(sessionId, terminalId));
  }

  /** Close one tab: its shell is killed if still running, and it leaves the list. */
  close(sessionId: string, terminalId: string): void {
    const terms = this.sessions.get(sessionId) ?? [];
    const term = terms.find((t) => t.id === terminalId);
    if (!term) return;
    const rest = terms.filter((t) => t !== term);
    if (rest.length) this.sessions.set(sessionId, rest);
    else this.sessions.delete(sessionId);
    this.stop(term);
    this.changed(sessionId);
  }

  /** Every terminal of a session goes (the session was deleted). */
  kill(sessionId: string): void {
    const terms = this.sessions.get(sessionId);
    if (!terms) return;
    this.sessions.delete(sessionId);
    for (const term of terms) this.stop(term);
    this.changed(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private find(sessionId: string, terminalId: string): Running | undefined {
    return this.sessions.get(sessionId)?.find((t) => t.id === terminalId);
  }

  private stop(term: Running): void {
    if (term.titleTimer) clearTimeout(term.titleTimer);
    term.titleTimer = null;
    term.clients.clear();
    this.watched('', term);
    this.dropRun(term);
    if (term.exitCode === null) term.pty.kill();
  }

  private exited(sessionId: string, term: Running, exitCode: number): void {
    if (this.find(sessionId, term.id) !== term) return; // closed already; nobody is listening
    term.exitCode = exitCode;
    term.program = term.shellName;
    this.dropRun(term);
    if (term.titleTimer) clearTimeout(term.titleTimer);
    term.titleTimer = null;
    for (const c of term.clients) c.exit(exitCode);
    term.clients.clear();
    this.watched(sessionId, term);
    this.changed(sessionId);
  }

  /**
   * node-pty has no event for "the foreground program changed", but a program that starts or
   * ends almost always prints, so output is the moment to ask. Asked at most every
   * `titleCheckMs`, with one more check after a burst so the last change is not missed.
   */
  private checkTitle(sessionId: string, term: Running): void {
    if (term.exitCode !== null || term.titleTimer) return;
    const now = Date.now();
    const wait = term.lastTitleCheck + this.titleCheckMs - now;
    if (wait > 0) {
      term.titleTimer = setTimeout(() => {
        term.titleTimer = null;
        this.checkTitle(sessionId, term);
      }, wait);
      term.titleTimer.unref?.();
      return;
    }
    term.lastTitleCheck = now;
    const program = programName(term);
    if (program === term.program) return;
    term.program = program;
    this.changed(sessionId);
  }

  /** Start the periodic title check when the first client attaches; stop it when the last one leaves or the shell ends. */
  private watched(sessionId: string, term: Running): void {
    const wanted = term.clients.size > 0 && term.exitCode === null && this.titlePollMs > 0;
    if (wanted && !term.poll) {
      term.poll = setInterval(() => this.checkTitle(sessionId, term), this.titlePollMs);
      term.poll.unref?.();
    } else if (!wanted && term.poll) {
      clearInterval(term.poll);
      term.poll = null;
    }
  }

  private changed(sessionId: string): void {
    for (const listener of this.listeners) listener(sessionId);
  }
}

/** The foreground program's short name, or the shell's when node-pty cannot say. */
function programName(term: Running): string {
  let name: unknown;
  try {
    name = term.pty.process;
  } catch {
    name = undefined; // the pty is closing; keep the shell's name
  }
  return typeof name === 'string' && name.trim() ? basename(name.trim()).slice(0, MAX_TITLE_CHARS) : term.shellName;
}
