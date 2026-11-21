// One Codex session: a long-lived `codex app-server` child (started on the first message, kept
// until the session is closed or the server stops), one thread on it, one turn at a time.
// A child that dies is reported as a failed turn with its stderr; the next message starts a new
// child and resumes the thread, as a restart of Kestrel does.
import { FILE_CHANGE_APPROVAL } from './approvals.ts';
import type { ElementLookup } from '../claude/describe.ts';
import { KESTREL_TOOLS, type AgentAttachment, type AgentEvent, type AgentHandle, type InputAnswer, type InputOption, type InputRequest, type MidTurnMessage, type StartOptions } from '../types.ts';
import type { PermissionLevel } from '../../shared/permissions.ts';
import { handleRequest, type CardReply } from './approvals.ts';
import type { ContextUsage } from '../../shared/context-usage.ts';
import { codexInstruction, KESTREL_SERVER, MCP_TOKEN_ENV, threadConfig } from './config.ts';
import { initialize, requireSignIn } from './connect.ts';
import { toContextUsage } from './context.ts';
import { STANDARD_TIER } from './models.ts';
import { codexInput, textInput, type CodexInput } from './input.ts';
import { listSkills, startsWithSlash } from './skills.ts';
import { CodexMapper, fileChanges, turnEnd, type FileChange } from './map.ts';
import { codexPolicy, policyParams, sandboxPolicy } from './policy.ts';
import { listAnswer, withListChoices, writableRoots } from './allow-list.ts';
import { CodexUnavailable, type AppServer, type ExitInfo, type Launch } from './process.ts';
import { RpcClosed, type IncomingRequest, type RpcConnection } from './rpc.ts';

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface HandleDeps {
  launch: Launch;
  env: Env;
  /** MCP server names in the user's config.toml (switched off unless enabled for the project). */
  configuredServers(): string[];
  version: string;
  /** Kestrel tools a session at this level does not get (read-only: the ones that change something). */
  omittedTools(level: PermissionLevel): readonly string[];
  /** The fast service tier of a model ('' is the Default), from the model probe; null when it has none. */
  fastTier(model: string): Promise<string | null>;
  /** Keeps a thread's latest context measurement, for the adapter's `contextUsage`. */
  noteContext(threadId: string, usage: ContextUsage): void;
  log(message: string): void;
}

/** `turn/start`'s reasoning effort and service tier for the session's settings; nothing for an unset one. */
/** `fastTier`: the model's fast tier id, null when it has none. Fast mode on a model without one sends nothing. */
export function speedParams(opts: Pick<StartOptions, 'effort' | 'fast'>, fastTier: string | null): { effort?: string; serviceTierForTurn?: string } {
  const out: { effort?: string; serviceTierForTurn?: string } = {};
  if (opts.effort) out.effort = opts.effort;
  if (opts.fast === true && fastTier) out.serviceTierForTurn = fastTier;
  else if (opts.fast === false) out.serviceTierForTurn = STANDARD_TIER;
  return out;
}

/** What approving a plan moves the session to, by option id (as for Claude). */
const PLAN_LEVELS: Record<string, PermissionLevel> = { 'approve-edits': 'edits', 'approve-ask': 'ask' };
const PLAN_OPTIONS: InputOption[] = [
  { id: 'approve-edits', label: 'Approve, accept edits', role: 'allow' },
  { id: 'approve-ask', label: 'Approve, ask before edits', role: 'allow' },
  { id: 'deny', label: 'Keep planning', role: 'deny' },
];
export const IMPLEMENT_PLAN = 'The user approved your plan. Implement it now.';
/** How long a refused file change waits for its reason to reach the running turn before it is declined. */
const STEER_WAIT_MS = 3000;
/** Put before what Kestrel tells the agent with its next message, when the turn it was about had already ended. */
export const LATE_NOTE = 'From Kestrel, about your previous turn: ';

/**
 * Said, with the edit rule's own reason, of a file change Codex applied without asking: one inside the
 * folders its sandbox lets it write (Auto), which Kestrel only sees once it is made.
 */
export const appliedUnasked = (reason: string): string =>
  `Kestrel could not refuse this change before it was made: the file is inside a folder Codex's sandbox lets it write without asking. It should not have been made from this session. ${reason}`;

interface Card {
  /** The JSON-RPC request it answers; null for the plan card, which answers no request. */
  rpcId: IncomingRequest['id'] | null;
  reply(answer: InputAnswer): CardReply;
  cancel: unknown;
  /** For the plan card: hands the answer to the waiting turn. */
  settle?(answer: InputAnswer | null): void;
}

class TurnAbandoned extends Error {}

export class CodexHandle implements AgentHandle {
  private threadId: string | null;
  private model = '';
  private server: AppServer | null = null;
  private starting: Promise<AppServer> | null = null;
  private running = false;
  private stopping = false;
  private closed = false;
  private turnId: string | null = null;
  private turn: Promise<void> = Promise.resolve();
  private turnToken = 0;
  private mapper: CodexMapper | null = null;
  private waiter: { resolve(turn: unknown): void; reject(error: Error): void } | null = null;
  private readonly cards = new Map<string, Card>();
  private cardSeq = 0;
  /** How the last child ended, for the reason a start that failed gives. */
  private lastExit: ExitInfo | null = null;
  /** The latest `thread/tokenUsage/updated` of the running turn, sent as `context` when it ends. */
  private usage: unknown = null;
  /** What Kestrel has to tell the agent that found no running turn: it goes with the next message. */
  private notes: string[] = [];
  /** File changes of this turn Codex asked about (the edit rule saw them before they were made), by item id. */
  private readonly asked = new Set<string>();
  /** Messages steered into the running turn (`sendNow`) that the model has not been given yet, by Kestrel's id. */
  private readonly steered = new Set<string>();

  constructor(
    threadId: string | null,
    private opts: StartOptions,
    private readonly emit: (event: AgentEvent) => void,
    private readonly deps: HandleDeps,
  ) {
    this.threadId = threadId;
  }

  agentSessionId = () => this.threadId;
  busy = () => this.running;

  send(text: string, attachments?: readonly AgentAttachment[]): void {
    if (this.closed) throw new Error('This Codex session was closed.');
    if (this.running) throw new Error('The agent is still working on the previous message.');
    this.running = true;
    this.stopping = false;
    const token = ++this.turnToken;
    // The terminal event goes out after the state is cleared, so a listener can send again at once.
    this.turn = this.runTurn(text, attachments).then((terminal) => {
      if (token === this.turnToken) {
        this.running = false;
        this.turnId = null;
        this.mapper = null;
        // Steered and never shown as given to the model: Codex keeps no queue Kestrel could ask about, so they stay as sent.
        this.steered.clear();
      }
      this.emit(terminal);
    });
  }

  /**
   * A message while the agent works: `turn/steer` on the running turn, which Codex adds to that turn's
   * input for the model's next request. Codex refuses it when no turn is running (or it has just ended),
   * or for a turn that cannot be steered (a review, a compaction); then Kestrel holds the message. The
   * `userMessage` item Codex adds when it gives the model the message (its `clientId` is ours) marks it read.
   */
  async sendNow(message: MidTurnMessage): Promise<boolean> {
    const rpc = this.server?.rpc;
    if (!this.running || this.stopping || this.closed || !rpc || !this.threadId || !this.turnId) return false;
    try {
      this.steered.add(message.id);
      await rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: codexInput(message.text, message.attachments), clientUserMessageId: message.id });
      return true;
    } catch (error) {
      this.steered.delete(message.id);
      this.deps.log(`Codex did not take a message on its turn, so Kestrel holds it: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  answer(requestId: string, answer: InputAnswer): void {
    const card = this.cards.get(requestId);
    if (!card) throw new Error('That question is no longer waiting for an answer.');
    this.cards.delete(requestId);
    if (card.settle) return card.settle(answer);
    const reply = card.reply(answer);
    if (card.rpcId !== null) this.server?.rpc.respond(card.rpcId, reply.result);
    if (reply.steer) void this.tell(reply.steer);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.dropCards();
    const server = this.server;
    if (server && this.threadId && this.turnId) {
      // If Codex cannot interrupt, the child is ended: the turn then ends as stopped.
      await server.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => server.kill());
    } else if (!server) {
      // Still starting: end the child being started (or abandon the start).
      this.waiter?.reject(new TurnAbandoned());
      void this.starting?.then((s) => s.kill(), () => undefined);
    }
    await this.turn;
  }

  /** Codex reports no background work Kestrel could list, so there is nothing to stop. */
  async stopBackgroundTask(): Promise<void> {
    throw new Error('Codex does not report background work, so Kestrel cannot stop it.');
  }

  /** Ends the turn (if any) and the child. The handle cannot be used afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    this.server?.kill();
    this.server = null;
  }

  // ---- turn ---------------------------------------------------------------------------

  /** Runs one turn (and, after an approved plan, the turn that implements it). Never rejects. */
  private async runTurn(text: string, attachments?: readonly AgentAttachment[]): Promise<AgentEvent> {
    try {
      const server = await this.ensureServer();
      if (this.stopping) return { type: 'done', reason: 'stopped' };
      // A message that may call a skill ("/name ..."): Codex is asked what it lists here, so the
      // skill goes as one (skills.ts). Any other message costs nothing extra.
      const skills = startsWithSlash(text) ? await listSkills(server.rpc, this.opts.directory) : [];
      for (let next: CodexInput[] | null = codexInput(text, attachments, skills); next; ) {
        const policy = codexPolicy(this.opts.permission);
        const mapper = new CodexMapper(this.opts.directory, this.opts.browserElement as ElementLookup | undefined);
        this.mapper = mapper;
        const turn = await this.oneTurn(server.rpc, next, policy.plan);
        this.reportPoint(turn);
        this.reportContext();
        const end = turnEnd(turn, this.stopping, mapper.lastError);
        next = null;
        if (end.type !== 'done' || end.reason !== 'complete' || !policy.plan || !mapper.plan || this.stopping) return end;
        next = await this.afterPlan(mapper.plan);
        if (!next) return { type: 'done', reason: this.stopping ? 'stopped' : 'complete' };
      }
      return { type: 'done', reason: 'complete' };
    } catch (error) {
      if (this.stopping || error instanceof TurnAbandoned) return { type: 'done', reason: 'stopped' };
      if (error instanceof CodexUnavailable) return { type: 'failed', reason: error.message, kind: error.kind === 'auth' ? 'auth' : 'other' };
      return { type: 'failed', reason: error instanceof Error ? error.message : String(error), kind: 'other' };
    }
  }

  /** Where the turn ends in the thread (its id), which `thread/fork`'s `lastTurnId` takes (Fork). */
  private reportPoint(turn: unknown): void {
    const point = (isObj(turn) ? str(turn.id) : '') || this.turnId;
    if (point) this.emit({ type: 'turn-point', point });
  }

    /** The context window as the turn left it, when Codex measured it. */
  private reportContext(): void {
    const usage = this.usage && this.threadId ? toContextUsage(this.usage, this.opts.model || this.model) : null;
    this.usage = null;
    if (!usage || !this.threadId) return;
    this.deps.noteContext(this.threadId, usage);
    this.emit({ type: 'context', usage });
  }

  private async oneTurn(rpc: RpcConnection, input: CodexInput[], plan: boolean): Promise<unknown> {
    const policy = codexPolicy(this.opts.permission);
    const speed = speedParams(this.opts, this.opts.fast ? await this.deps.fastTier(this.opts.model ?? '') : null);
    const done = new Promise<unknown>((resolve, reject) => (this.waiter = { resolve, reject }));
    done.catch(() => undefined); // observed below; a rejection before then must not go unhandled
    // Forget the previous turn first: this one's notifications can arrive before turn/start's reply.
    this.turnId = null;
    this.asked.clear();
    const notes = this.notes.splice(0).map((note) => textInput(`${LATE_NOTE}${note}`));
    const started = await rpc.request('turn/start', {
      threadId: this.threadId,
      input: [...input, ...notes],
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      // Read-and-write folders on the always-allowed list are writable too, from the next turn after a change.
      sandboxPolicy: sandboxPolicy(policy.sandbox, writableRoots(this.opts.sandboxAllow?.entries() ?? [])),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...speed,
      // Set every turn: a plan turn leaves the thread in plan mode otherwise. The mode's settings
      // carry the effort too, since they take precedence over the turn's own.
      collaborationMode: { mode: plan ? 'plan' : 'default', settings: { model: this.opts.model || this.model, reasoning_effort: speed.effort ?? null, developer_instructions: null } },
    });
    const id = isObj(started) && isObj(started.turn) ? str(started.turn.id) : '';
    if (!id) throw new Error('Codex started a turn but did not say which.');
    this.turnId = id;
    if (this.stopping) await rpc.request('turn/interrupt', { threadId: this.threadId, turnId: id }).catch(() => undefined);
    return done;
  }

  /** The "Plan ready" card. Approved: the level changes and the next turn implements it. Kept planning with a note: another plan turn. */
  private async afterPlan(plan: string): Promise<CodexInput[] | null> {
    const id = `codex-plan-${++this.cardSeq}`;
    const answer = await new Promise<InputAnswer | null>((settle) => {
      this.cards.set(id, { rpcId: null, reply: () => ({ result: null }), cancel: null, settle });
      this.emit({ type: 'needs-input', request: { id, kind: 'approval', tool: 'ExitPlanMode', title: 'Plan ready', detail: plan, markdown: true, options: PLAN_OPTIONS } });
    });
    if (!answer || this.stopping) return null;
    const level = PLAN_LEVELS[answer.optionId ?? ''];
    if (!level) return answer.text?.trim() ? [textInput(answer.text.trim())] : null;
    this.opts = { ...this.opts, permission: level };
    this.emit({ type: 'mode', permission: level });
    return [textInput(IMPLEMENT_PLAN)];
  }

  /**
   * Tells the agent `text`: on the running turn (`turn/steer`) when there is one, else with the next
   * message. Codex refuses a steer once the turn has ended, and a decline carries no message of its
   * own, so nothing said here is lost.
   */
  private async tell(text: string): Promise<void> {
    const rpc = this.server?.rpc;
    if (rpc && this.threadId && this.turnId) {
      try {
        await rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [textInput(text)] });
        return;
      } catch (error) {
        this.deps.log(`could not tell Codex on its turn, so it goes with the next message: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.notes.push(text);
  }

  /** The edit rule's reason for refusing any of `changes` (the first one refused), or null when every one may be made. */
  private async editRefusal(changes: readonly FileChange[]): Promise<string | null> {
    for (const path of changes.flatMap((c) => (c.movePath ? [c.path, c.movePath] : [c.path]))) {
      const verdict = await this.opts.intercept?.({ tool: 'Edit', input: { file_path: path } }).catch(() => undefined);
      if (verdict && !verdict.allow) return verdict.message;
    }
    return null;
  }

  /**
   * Declines a file change the edit rule refused. The reason is said to the agent first, so it is on
   * the turn when Codex tells the model the change was rejected, and shown on the change itself.
   */
  private async refuseChange(server: AppServer, rpcId: IncomingRequest['id'], itemId: string, reason: string): Promise<void> {
    const mapper = this.mapper;
    if (mapper) this.emit(mapper.refuse(itemId, reason));
    // Codex answers a steer at once; should it not, the change is declined anyway, a moment later.
    await Promise.race([this.tell(reason), new Promise((resolve) => setTimeout(resolve, STEER_WAIT_MS).unref())]);
    server.rpc.respond(rpcId, { decision: 'decline' });
  }

  /**
   * A file change Codex applied without asking (inside its sandbox, in Auto): the edit rule could not
   * stop it, so when it would have refused it, the user and the agent are told, with the reason.
   */
  private async checkApplied(item: Obj): Promise<void> {
    const changes = fileChanges(item);
    const reason = await this.editRefusal(changes);
    if (!reason) return;
    const note = appliedUnasked(reason);
    this.emit(new CodexMapper(this.opts.directory).note(str(item.id), changes, note));
    await this.tell(note);
  }

  private dropCards(): void {
    for (const [id, card] of this.cards) {
      this.cards.delete(id);
      if (card.settle) card.settle(null);
      else if (card.rpcId !== null) this.server?.rpc.respond(card.rpcId, card.cancel);
    }
  }

  // ---- the child ----------------------------------------------------------------------

  private ensureServer(): Promise<AppServer> {
    if (this.server && !this.server.rpc.closed) return Promise.resolve(this.server);
    this.starting ??= this.startServer().finally(() => (this.starting = null));
    return this.starting;
  }

  private async startServer(): Promise<AppServer> {
    this.emit({ type: 'status', text: 'Starting Codex…' });
    const policy = codexPolicy(this.opts.permission);
    const access = this.opts.kestrelMcp;
    const server = this.deps.launch({
      env: { ...this.deps.env, ...this.opts.env, ...(access ? { [MCP_TOKEN_ENV]: access.token } : {}) },
      handlers: {
        notification: (method, params) => this.onNotification(method, params),
        request: (request) => void this.onRequest(server, request),
        problem: (message) => this.deps.log(`Codex sent something Kestrel could not read: ${message}`),
      },
      onExit: (info) => this.onExit(server, info),
    });
    try {
      await initialize(server.rpc, this.deps.version);
      await requireSignIn(server.rpc);
      const params = {
        cwd: this.opts.directory,
        ...policyParams(policy),
        ...(this.opts.model ? { model: this.opts.model } : {}),
        config: threadConfig({ kestrelUrl: access?.url ?? null, setup: this.opts.setup, configuredServers: this.deps.configuredServers() }),
        developerInstructions: codexInstruction(this.opts.instruction),
      };
      const opened = this.threadId ? await server.rpc.request('thread/resume', { threadId: this.threadId, ...params, excludeTurns: true }) : await server.rpc.request('thread/start', params);
      const thread = isObj(opened) && isObj(opened.thread) ? opened.thread : null;
      if (!thread || !str(thread.id)) throw new Error(`Codex did not ${this.threadId ? 'resume' : 'start'} the conversation.`);
      this.threadId = str(thread.id);
      this.model = isObj(opened) ? str(opened.model) : '';
      this.server = server;
      this.emit(await this.startedEvent(server.rpc, policy.readOnly ? this.deps.omittedTools(this.opts.permission) : []));
      return server;
    } catch (error) {
      server.kill();
      const exit = this.lastExit;
      if (error instanceof RpcClosed && exit) throw new Error(`Codex stopped while starting (${exit.signal ?? `exit code ${exit.code}`}).${exit.stderr ? `\n\nIts last output:\n${exit.stderr}` : ''}`);
      throw error;
    }
  }

  /** `started`, with whether Codex really has every Kestrel tool (from its own MCP status). */
  private async startedEvent(rpc: RpcConnection, omitted: readonly string[]): Promise<AgentEvent> {
    const expected = KESTREL_TOOLS.filter((t) => !omitted.includes(t)) as string[];
    const base = { type: 'started' as const, agentSessionId: this.threadId!, model: this.model };
    if (!this.opts.kestrelMcp) return { ...base, kestrelTools: 'missing', missing: expected, detail: 'Kestrel did not give this session its tools.' };
    const listed = await rpc.request('mcpServerStatus/list', { threadId: this.threadId }).catch(() => null);
    const servers = isObj(listed) && Array.isArray(listed.data) ? listed.data.filter(isObj) : [];
    const kestrel = servers.find((s) => s.name === KESTREL_SERVER);
    const tools = kestrel && isObj(kestrel.tools) ? Object.keys(kestrel.tools) : [];
    const missing = expected.filter((t) => !tools.includes(t));
    const detail = servers.map((s) => `${str(s.name)}: ${str(s.runtimeStatus) || 'unknown'}`).join(', ');
    return { ...base, kestrelTools: kestrel && missing.length === 0 ? 'connected' : 'missing', missing, detail };
  }

  private onExit(server: AppServer, info: ExitInfo): void {
    this.lastExit = info;
    if (this.server === server) this.server = null;
    this.dropCardsOf();
    if (this.closed || this.stopping) return this.waiter?.reject(new TurnAbandoned());
    const how = info.signal ? `was ended (${info.signal})` : `exited with code ${info.code}`;
    this.waiter?.reject(new Error(`Codex stopped unexpectedly: it ${how}.${info.stderr ? `\n\nIts last output:\n${info.stderr}` : ''}`));
  }

  /** A dead child's cards can no longer be answered. */
  private dropCardsOf(): void {
    for (const [id, card] of this.cards) if (!card.settle) this.cards.delete(id);
  }

  private onNotification(method: string, params: Obj): void {
    if (typeof params.threadId === 'string' && this.threadId && params.threadId !== this.threadId) return;
    if (method === 'turn/started' && isObj(params.turn) && !this.turnId) this.turnId = str(params.turn.id) || null;
    if (method === 'thread/tokenUsage/updated') return void (this.usage = params.tokenUsage);
    if (this.readSteer(method, params)) return;
    if (method === 'turn/completed') {
      const turn = isObj(params.turn) ? params.turn : {};
      if (this.turnId && str(turn.id) && str(turn.id) !== this.turnId) return;
      const waiter = this.waiter;
      this.waiter = null;
      return waiter?.resolve(turn);
    }
    if (method === 'item/completed' && isObj(params.item) && params.item.type === 'fileChange' && params.item.status === 'completed' && !this.asked.has(str(params.item.id))) void this.checkApplied(params.item);
    for (const event of this.mapper?.map(method, params) ?? []) this.emit(event);
  }

  /** A `userMessage` item for a message steered into the turn: the model has it now. True when it was one. */
  private readSteer(method: string, params: Obj): boolean {
    if (method !== 'item/started' && method !== 'item/completed') return false;
    const item = isObj(params.item) ? params.item : null;
    const id = item?.type === 'userMessage' ? str(item.clientId) : '';
    if (!id || !this.steered.delete(id)) return false;
    this.emit({ type: 'picked-up', ids: [id] });
    return true;
  }

  private async onRequest(server: AppServer, request: IncomingRequest): Promise<void> {
    const params = request.params;
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return server.rpc.fail(request.id, { code: -32602, message: 'Kestrel has no such thread.' });
    // A file change is put to Kestrel's edit rule first, whatever the level: one that is refused (a file
    // in another project, or in another session's worktree) is declined, and the agent is told why and
    // what to do instead. Every level that writes has Codex ask about the changes it can (policy.ts).
    if (request.method === FILE_CHANGE_APPROVAL) {
      const itemId = str(params.itemId);
      const changes = this.mapper?.changes.get(itemId) ?? [];
      // A change whose files Kestrel was not told of is checked again once it is made.
      if (changes.length) this.asked.add(itemId);
      const refusal = await this.editRefusal(changes);
      if (refusal) return this.refuseChange(server, request.id, itemId, refusal);
    }
    // A command or more access the user put on the always-allowed list is accepted without a card (allow-list.ts).
    const listed = listAnswer(request.method, params, codexPolicy(this.opts.permission), this.opts);
    if (listed) return server.rpc.respond(request.id, listed);
    const cardId = `codex-${++this.cardSeq}`;
    const handling = handleRequest(request.method, params, cardId, {
      policy: codexPolicy(this.opts.permission),
      directory: this.opts.directory,
      changes: (itemId) => this.mapper?.changes.get(itemId),
      element: this.opts.browserElement,
    });
    if (handling.kind === 'refuse') {
      this.deps.log(`refused a request from Codex: ${request.method}`);
      return server.rpc.fail(request.id, handling.error);
    }
    if (handling.kind === 'answer') return server.rpc.respond(request.id, handling.result);
    // Rules (annoyances) see what is about to run and may refuse it with a reason.
    const verdict = await this.opts.intercept?.({ tool: handling.request.tool, input: { detail: handling.request.detail } }).catch(() => undefined);
    if (verdict && !verdict.allow) {
      const reply = handling.reply({ optionId: 'deny', text: verdict.message });
      await this.tell(verdict.message);
      return server.rpc.respond(request.id, reply.result);
    }
    const card = await withListChoices(handling.request, request.method, params, codexPolicy(this.opts.permission), this.opts);
    if (this.stopping) return server.rpc.respond(request.id, handling.cancel);
    this.cards.set(cardId, { rpcId: request.id, reply: handling.reply, cancel: handling.cancel });
    this.emit({ type: 'needs-input', request: card });
  }
}
