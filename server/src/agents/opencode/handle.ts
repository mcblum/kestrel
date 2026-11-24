// One OpenCode session: a long-lived `opencode serve` child (started on the first message, kept until
// the session is closed or the server stops), one OpenCode session on it, one turn at a time. The
// child's event stream is read for as long as it lives; a turn ends when OpenCode says the session
// is idle. A child that dies is reported as a failed turn with what it printed; the next message
// starts a new child and resumes the session, as a restart of Kestrel does.
import type { ContextUsage } from '../../shared/context-usage.ts';
import type { PermissionLevel } from '../../shared/permissions.ts';
import type { ElementLookup } from '../claude/describe.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentAttachment, AgentEvent, AgentHandle, InputAnswer, InputOption, StartOptions } from '../types.ts';
import { AskDesk } from './asks.ts';
import { call, clientFor, type OpencodeClient } from './client.ts';
import { isolationEnv, processConfig } from './config.ts';
import { commandCalled, promptParts, slashCommands } from './input.ts';
import { writeInstruction, type InstructionFile } from './instruction.ts';
import { OpencodeMapper } from './map.ts';
import { splitModel } from './models.ts';
import { opencodePolicy, sessionRules } from './policy.ts';
import { OpencodeUnavailable, type ExitInfo, type Launch, type OpencodeServer } from './process.ts';
import { startedEvent } from './started.ts';
import { turnEnd, type TurnOutcome } from './turn-end.ts';

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface HandleDeps {
  launch: Launch;
  env: Env;
  /** MCP server names the user's OpenCode files define for a session in this folder. */
  configuredServers(directory: string): string[];
  /** A model's context window in tokens (from the probe); 0 when unknown. */
  contextWindow(model: string): Promise<number>;
  /** Keeps a session's latest context measurement, for the adapter's `contextUsage`. */
  noteContext(sessionId: string, usage: ContextUsage): void;
  log(message: string): void;
}

/** What approving a plan moves the session to, by option id (as for Claude and Codex). */
const PLAN_LEVELS: Record<string, PermissionLevel> = { 'approve-edits': 'edits', 'approve-ask': 'ask' };
const PLAN_OPTIONS: InputOption[] = [
  { id: 'approve-edits', label: 'Approve, accept edits', role: 'allow' },
  { id: 'approve-ask', label: 'Approve, ask before edits', role: 'allow' },
  { id: 'deny', label: 'Keep planning', role: 'deny' },
];
export const IMPLEMENT_PLAN = 'The user approved your plan. Implement it now.';
/** A retry OpenCode schedules further out than this (a used-up free tier: hours) ends the turn instead. */
export const MAX_RETRY_WAIT_MS = 120_000;
const SESSION_TITLE = 'Kestrel';
/** How long after `session.summarize` answers its events may still be arriving. */
const COMPACTION_IDLE_WAIT_MS = 2_000;

class TurnAbandoned extends Error {}

export class OpencodeHandle implements AgentHandle {
  private sessionId: string | null;
  private server: { process: OpencodeServer; client: OpencodeClient; events: AbortController; instruction: InstructionFile } | null = null;
  private starting: Promise<OpencodeClient> | null = null;
  private running = false;
  private stopping = false;
  private closed = false;
  private turn: Promise<void> = Promise.resolve();
  private turnToken = 0;
  private mapper: OpencodeMapper | null = null;
  private waiter: { resolve(): void; reject(error: Error): void } | null = null;
  private appliedRules: string | null = null;
  private commands: { name: string; description: string }[] = [];
  /** Why Kestrel ended the turn itself (a retry hours away), for the failed turn's reason. */
  private gaveUp: string | null = null;
  private planSettle: ((answer: InputAnswer | null) => void) | null = null;
  private readonly desk: AskDesk;

  constructor(
    sessionId: string | null,
    private opts: StartOptions,
    private readonly emit: (event: AgentEvent) => void,
    private readonly deps: HandleDeps,
  ) {
    this.sessionId = sessionId;
    this.desk = new AskDesk({ client: () => this.server?.client ?? null, opts: () => this.opts, mapper: () => this.mapper, emit, log: deps.log });
  }

  agentSessionId = () => this.sessionId;
  busy = () => this.running;

  send(text: string, attachments?: readonly AgentAttachment[]): void {
    this.begin(() => this.runTurn(text, attachments));
  }

  /** OpenCode's own compaction (`session.summarize`) with the session's model, followed as a turn. */
  compact(): void {
    if (!this.sessionId) throw new Error('This conversation has not started yet, so there is nothing to compact.');
    this.begin(() => this.runCompaction());
  }

  private begin(run: () => Promise<AgentEvent>): void {
    if (this.closed) throw new Error('This OpenCode session was closed.');
    if (this.running) throw new Error('The agent is still working on the previous message.');
    this.running = true;
    this.stopping = false;
    const token = ++this.turnToken;
    this.turn = run().then((terminal) => {
      if (token === this.turnToken) this.running = false;
      this.emit(terminal);
    });
  }

  answer(requestId: string, answer: InputAnswer): void {
    if (requestId === 'opencode-plan' && this.planSettle) {
      const settle = this.planSettle;
      this.planSettle = null;
      return settle(answer);
    }
    this.desk.answer(requestId, answer);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.planSettle?.(null);
    this.planSettle = null;
    await this.desk.dropAll();
    const server = this.server;
    if (server && this.sessionId) {
      await call('stop the turn', server.client.session.abort({ sessionID: this.sessionId })).catch(() => server.process.kill());
    } else {
      this.waiter?.reject(new TurnAbandoned());
      void this.starting?.then(() => this.server?.process.kill(), () => undefined);
    }
    await this.turn;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    this.endServer();
  }

  // ---- turn ---------------------------------------------------------------------------

  private async runTurn(text: string, attachments?: readonly AgentAttachment[]): Promise<AgentEvent> {
    try {
      const client = await this.ensureServer();
      if (this.stopping) return { type: 'done', reason: 'stopped' };
      let message: { text: string; attachments?: readonly AgentAttachment[] } | null = { text, attachments };
      let cost = 0;
      while (message) {
        const outcome = await this.oneTurn(client, message.text, message.attachments);
        cost += outcome.costUsd;
        const end = turnEnd(outcome, this.stopping, this.gaveUp, cost);
        if (end.type !== 'done' || end.reason !== 'complete' || !opencodePolicy(this.opts.permission).plan || !outcome.text) return end;
        message = await this.afterPlan(outcome.text);
        if (!message) return { ...end, reason: this.stopping ? 'stopped' : 'complete' };
      }
      return { type: 'done', reason: 'complete' };
    } catch (error) {
      if (this.stopping || error instanceof TurnAbandoned) return { type: 'done', reason: 'stopped' };
      if (error instanceof OpencodeUnavailable) return { type: 'failed', reason: error.message, kind: error.kind === 'auth' ? 'auth' : 'other' };
      return { type: 'failed', reason: error instanceof Error ? error.message : String(error), kind: 'other' };
    }
  }

  /** A compaction: `session.summarize` answers once OpenCode has compacted; its events stream as a turn's do. Never rejects. */
  private async runCompaction(): Promise<AgentEvent> {
    try {
      const client = await this.ensureServer();
      if (this.stopping) return { type: 'done', reason: 'stopped' };
      const mapper = this.mapper!;
      mapper.beginTurn();
      this.gaveUp = null;
      const model = this.opts.model ? splitModel(this.opts.model) : null;
      const idle = new Promise<void>((resolve, reject) => (this.waiter = { resolve, reject }));
      idle.catch(() => undefined); // observed below
      await call('compact the conversation', client.session.summarize({ sessionID: this.sessionId!, ...(model ?? {}), auto: false }));
      // The answer can come before the events that went with it (the summary's tokens, then idle): wait for idle, briefly.
      const late = new AbortController();
      await Promise.race([idle, delay(COMPACTION_IDLE_WAIT_MS, undefined, { signal: late.signal }).catch(() => undefined)]);
      late.abort();
      this.waiter = null;
      await this.reportContext(mapper);
      return turnEnd({ error: mapper.lastError, text: mapper.lastText, costUsd: mapper.usage.costUsd }, this.stopping, this.gaveUp, mapper.usage.costUsd);
    } catch (error) {
      if (this.stopping || error instanceof TurnAbandoned) return { type: 'done', reason: 'stopped' };
      if (error instanceof OpencodeUnavailable) return { type: 'failed', reason: error.message, kind: error.kind === 'auth' ? 'auth' : 'other' };
      return { type: 'failed', reason: error instanceof Error ? error.message : String(error), kind: 'other' };
    }
  }

  private async oneTurn(client: OpencodeClient, text: string, attachments?: readonly AgentAttachment[]): Promise<TurnOutcome> {
    const sessionID = this.sessionId!;
    const mapper = this.mapper!;
    await this.applyRules(client);
    mapper.beginTurn();
    this.gaveUp = null;
    const done = new Promise<void>((resolve, reject) => (this.waiter = { resolve, reject }));
    done.catch(() => undefined);
    const policy = opencodePolicy(this.opts.permission);
    const model = this.opts.model ? splitModel(this.opts.model) : null;
    const variant = this.opts.effort ? { variant: this.opts.effort } : {};
    const command = commandCalled(text, this.commands);
    if (command) {
      // Runs until the turn ends; its answer is not needed, only a refusal.
      void call('run the command', client.session.command({ sessionID, command: command.command, arguments: command.arguments, agent: policy.agent, ...(this.opts.model ? { model: this.opts.model } : {}), ...variant })).catch((error: Error) => this.waiter?.reject(error));
    } else {
      await call('take the message', client.session.promptAsync({ sessionID, agent: policy.agent, parts: promptParts(text, attachments), ...(model ? { model } : {}), ...variant }));
    }
    if (this.stopping) await client.session.abort({ sessionID }).catch(() => undefined);
    await done;
    const outcome: TurnOutcome = { error: mapper.lastError, text: mapper.lastText, costUsd: mapper.usage.costUsd };
    await this.reportContext(mapper);
    return outcome;
  }

  /** The level's own rules on the OpenCode session (policy.ts `sessionRules`), when they changed. */
  private async applyRules(client: OpencodeClient): Promise<void> {
    const rules = sessionRules(this.opts.permission);
    const key = JSON.stringify(rules);
    if (key === this.appliedRules) return;
    await call('set the session permissions', client.session.update({ sessionID: this.sessionId!, permission: rules }));
    this.appliedRules = key;
  }

  private async reportContext(mapper: OpencodeMapper): Promise<void> {
    const model = mapper.model || this.opts.model || '';
    const window = model && mapper.usage.contextTokens ? await this.deps.contextWindow(model).catch(() => 0) : 0;
    if (!window || !this.sessionId) return;
    const used = mapper.usage.contextTokens;
    const usage: ContextUsage = { model, usedTokens: used, windowTokens: window, rows: [{ name: 'Conversation', tokens: used, kind: 'used' }, { name: 'Free space', tokens: Math.max(0, window - used), kind: 'free' }], at: Date.now() };
    this.deps.noteContext(this.sessionId, usage);
    this.emit({ type: 'context', usage });
  }

  /** The "Plan ready" card. Approved: the level changes and the next turn implements it. Kept planning with a note: another plan turn. */
  private async afterPlan(plan: string): Promise<{ text: string } | null> {
    const answer = await new Promise<InputAnswer | null>((settle) => {
      this.planSettle = settle;
      this.emit({ type: 'needs-input', request: { id: 'opencode-plan', kind: 'approval', tool: 'ExitPlanMode', title: 'Plan ready', detail: plan, markdown: true, options: PLAN_OPTIONS } });
    });
    if (!answer || this.stopping) return null;
    const level = PLAN_LEVELS[answer.optionId ?? ''];
    if (!level) return answer.text?.trim() ? { text: answer.text.trim() } : null;
    this.opts = { ...this.opts, permission: level };
    this.emit({ type: 'mode', permission: level });
    return { text: IMPLEMENT_PLAN };
  }

  // ---- the child ----------------------------------------------------------------------

  private ensureServer(): Promise<OpencodeClient> {
    if (this.server) return Promise.resolve(this.server.client);
    this.starting ??= this.startServer().finally(() => (this.starting = null));
    return this.starting;
  }

  private async startServer(): Promise<OpencodeClient> {
    this.emit({ type: 'status', text: 'Starting OpenCode…' });
    const instruction = writeInstruction(this.opts.instruction);
    const config = processConfig({ kestrel: this.opts.kestrelMcp ?? null, setup: this.opts.setup, configuredServers: this.deps.configuredServers(this.opts.directory), instructionFile: instruction.path });
    let process: OpencodeServer | null = null;
    try {
      process = await this.deps.launch({ env: { ...this.deps.env, ...this.opts.env, ...isolationEnv(this.opts.setup) }, config, pure: this.opts.setup?.loadSettings === false, onExit: (info) => this.onExit(process, info) });
      const client = clientFor(process, this.opts.directory);
      const events = new AbortController();
      await this.listen(client, events.signal);
      this.appliedRules = null;
      const session = await this.openSession(client);
      this.sessionId = session;
      this.mapper = new OpencodeMapper(session, this.opts.directory, this.opts.browserElement as ElementLookup | undefined);
      this.server = { process, client, events, instruction };
      this.emit(await startedEvent(client, session, this.opts));
      await this.listCommands(client);
      return client;
    } catch (error) {
      process?.kill();
      instruction.remove();
      throw error;
    }
  }

  /** Resumes the stored session, or creates one with the level's rules. */
  private async openSession(client: OpencodeClient): Promise<string> {
    if (this.sessionId) {
      const found = await client.session.get({ sessionID: this.sessionId });
      if (found.error || !isObj(found.data)) throw new Error(`OpenCode has no conversation ${this.sessionId} any more, so this session cannot continue. Start a new one.`);
      return this.sessionId;
    }
    const created = await call<{ id?: unknown }>('start a conversation', client.session.create({ title: SESSION_TITLE, permission: sessionRules(this.opts.permission) }));
    if (typeof created?.id !== 'string' || !created.id) throw new Error('OpenCode started a conversation but did not say which.');
    this.appliedRules = JSON.stringify(sessionRules(this.opts.permission));
    return created.id;
  }

  private async listCommands(client: OpencodeClient): Promise<void> {
    const listed = await client.command.list().catch(() => null);
    if (!listed || listed.error) return;
    this.commands = slashCommands(listed.data);
    this.emit({ type: 'slash-commands', commands: this.commands });
  }

  /** Reads the child's events for as long as it lives. Resolves once the stream is open. */
  private async listen(client: OpencodeClient, signal: AbortSignal): Promise<void> {
    const subscribed = await client.event.subscribe(undefined, { signal, sseMaxRetryAttempts: 3 });
    const stream = subscribed.stream as AsyncGenerator<unknown>;
    const first = await stream.next();
    if (first.done) throw new Error('OpenCode closed its event stream at once.');
    void (async () => {
      try {
        for await (const event of stream) if (isObj(event)) await this.onEvent(event);
      } catch (error) {
        if (!signal.aborted) this.deps.log(`OpenCode's event stream ended: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  private async onEvent(event: Obj): Promise<void> {
    const mapper = this.mapper;
    if (!mapper) return;
    const p = isObj(event.properties) ? event.properties : {};
    const sessionID = str(p.sessionID);
    if (event.type === 'permission.asked' && mapper.belongs(sessionID)) return this.desk.onPermission(p);
    if (event.type === 'question.asked' && mapper.belongs(sessionID)) return this.desk.onQuestion(p);
    if (event.type === 'session.status' && sessionID === mapper.sessionID) this.checkRetry(p);
    if (event.type === 'session.idle' && sessionID === mapper.sessionID) {
      const waiter = this.waiter;
      this.waiter = null;
      return waiter?.resolve();
    }
    if (sessionID && !mapper.belongs(sessionID) && !event.type?.toString().startsWith('session.')) return;
    for (const out of mapper.map(event)) this.emit(out);
  }

  /** A retry hours away (a used-up free tier) is not waited for: the turn ends with OpenCode's reason. */
  private checkRetry(p: Obj): void {
    const status = isObj(p.status) ? p.status : {};
    if (status.type !== 'retry' || typeof status.next !== 'number' || status.next - Date.now() < MAX_RETRY_WAIT_MS || this.gaveUp) return;
    this.gaveUp = `${str(status.message) || 'OpenCode could not reach the model'} (OpenCode would only try again at ${new Date(status.next).toLocaleString()}).`;
    void this.server?.client.session.abort({ sessionID: this.sessionId! }).catch(() => undefined);
  }

  private endServer(): void {
    const server = this.server;
    this.server = null;
    this.mapper = null;
    server?.events.abort();
    server?.process.kill();
    server?.instruction.remove();
  }

  private onExit(process: OpencodeServer | null, info: ExitInfo): void {
    if (!process || this.server?.process !== process) return;
    this.endServer();
    this.desk.forget();
    if (this.closed || this.stopping) return this.waiter?.reject(new TurnAbandoned());
    const how = info.signal ? `was ended (${info.signal})` : `exited with code ${info.code}`;
    this.waiter?.reject(new Error(`OpenCode stopped unexpectedly: it ${how}.${info.output ? `\n\nIts last output:\n${info.output}` : ''}`));
  }
}
