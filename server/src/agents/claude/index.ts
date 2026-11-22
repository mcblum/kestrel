// Claude adapter: `query()` from the Claude Agent SDK, resumed by session id. One query per run: its
// input stays open while the agent works or waits on background work it left running, so a message
// sent while it is quiet on that work goes into the same query (see Run below and run-phase.ts), and
// so does one sent while it works (`sendNow`, mid-turn.ts): the CLI folds it into the running turn.
// Tool calls are gated with a PreToolUse hook (sees everything); approvals come from canUseTool.
import { readTaskOutput } from './task-output.ts';
import { stopClaudeTask } from './stop-task.ts';
import { forkSession, query, type CanUseTool, type HookCallback, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AgentAdapter, AgentAttachment, AgentEvent, AgentHandle, InputAnswer, InputRequest, MidTurnMessage, StartOptions } from '../types.ts';
import { MidTurnInput, type MessageUuid } from './mid-turn.ts';
import { userContent } from './content.ts';
import { PERMISSION_LEVELS, asksOutsideFolder, claudePermission, type PermissionLevel } from '../../shared/permissions.ts';
import { askContextUsage, claudeContextUsage } from './context.ts';
import { confinementDenial, writeOutside } from './confine.ts';
import { claudeModels } from './models.ts';
import { describeApproval, type ElementLookup } from './describe.ts';
import { ClaudeMapper, type SdkLike } from './map.ts';
import { InputChannel } from './input.ts';
import { RunPhase, type PhaseChange } from './run-phase.ts';
import { baseOptions, isConnectorTool } from './options.ts';
import { kestrelMcpServer } from './tools.ts';
import { claudeAvailability, claudeThrown } from './failure.ts';
import { cardOffer, isUnconfinedCommand, isUnsandboxed, offersAllowList, ON_LIST_NOTE, onAllowList, rewrittenDetail, shellSandbox, unconfinedNote, unconfinedReason, UNSANDBOXED_NOTE } from './sandbox.ts';
import { offerOptions } from '../../sandbox-allow/offer.ts';
import type { SandboxOffer } from '../../shared/sandbox-allow.ts';
import { askSlashCommands, claudeSlashCommands, leftOut, terminalOnlyOf } from './slash.ts';
import { slashCommandsFrom } from '../../shared/slash-commands.ts';

interface Pending {
  request: InputRequest;
  input: Record<string, unknown>;
  settle: (result: Awaited<ReturnType<CanUseTool>>) => void;
}

/** How long the end of a turn waits for the context measurement (it answers in milliseconds). */
const CONTEXT_WAIT_MS = 5_000;

const ALLOW: InputRequest['options'] = [
  { id: 'allow', label: 'Allow', role: 'allow' },
  { id: 'deny', label: 'Deny', role: 'deny' },
];
/** The choice, on a card for a command outside the sandbox, that stops the session asking about those. */
const ALLOW_OUTSIDE = 'allow-outside';
const ALLOW_OR_ALL_OUTSIDE: InputRequest['options'] = [ALLOW[0]!, { id: ALLOW_OUTSIDE, label: 'Allow all outside the sandbox', role: 'allow' }, ALLOW[1]!];

/** The note on an approval card, and the hook's reason, for an edit outside the session's folder. */
const OUTSIDE_NOTE = "Outside this session's folder";

/**
 * A user message as the SDK's streaming-input mode wants it: the plain text, or blocks when files are
 * attached (content.ts). Every one carries a uuid, so the turn that takes it in names it (mid-turn.ts).
 */
async function userMessage(text: string, attachments?: readonly AgentAttachment[], uuid: MessageUuid = randomUUID()): Promise<SDKUserMessage> {
  const content = await userContent(text, attachments);
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid };
}

/**
 * One run: a `query()` whose input stays open from the first message until the agent is done and
 * nothing it left in the background is alive (run-phase.ts). A message sent while the agent is quiet
 * on background work goes into this same query, so its dev servers and watchers keep running.
 */
interface Run {
  readonly input: InputChannel<SDKUserMessage>;
  readonly phase: RunPhase;
  readonly abort: AbortController;
  /** Messages sent into the run while it worked, until the agent has read them. */
  readonly midTurn: MidTurnInput;
  query: Query | null;
  /** Settles once the run has ended and its terminal event has gone out. */
  finished: Promise<void>;
  /** The run's slash commands were asked for (agents/claude/slash.ts). */
  commandsAsked?: boolean;
  /** The command names the CLI marked as terminal-only when it reported itself. */
  terminalOnly?: string[];
}

class ClaudeHandle implements AgentHandle {
  private sessionId: string | null;
  private run: Run | null = null;
  private stopping = false;
  /** `close` was called: the handle is replaced, so nothing it still hears goes out. */
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  /** The plan file this session last wrote in plan mode, shown on the "Plan ready" card. */
  private planFile: string | null = null;
  /**
   * The user chose "Allow all outside the sandbox" on a card: this session's commands that leave
   * the sandbox run without asking from then on (Matt, 2026-11-18: a delegated session asked about
   * every terraform command). Kestrel keeps the choice with the session (the `outside-allowed`
   * event, then `StartOptions.outsideAllowed`), so a restart does not ask again (Matt, 2026-11-18).
   */
  private outsideAllowed = false;
  /**
   * The command Claude itself wrote for each call that asks to leave the sandbox, by tool use id.
   * Hooks see the call as Claude wrote it; a user's own hook may rewrite it (`git x` → `rtk git x`),
   * and the approval callback then sees what will really run. The card shows both.
   */
  private readonly written = new Map<string, string>();
  /** Why Kestrel's hook refused a call, by tool use id: the call's failed step carries it as a refusal, not as a tool failure. */
  private readonly refusals = new Map<string, string>();

  constructor(
    sessionId: string | null,
    private opts: StartOptions,
    private readonly emitEvent: (event: AgentEvent) => void,
    private readonly runQuery: typeof query = query,
  ) {
    this.sessionId = sessionId;
    this.outsideAllowed = opts.outsideAllowed === true;
  }

  agentSessionId = () => this.sessionId;
  /** Generating or running a foreground tool. Quiet on background work is not busy: a message goes straight in. */
  busy = () => this.run !== null && this.run.phase.current !== 'background';

  send(text: string, attachments?: readonly AgentAttachment[]): void {
    const live = this.run;
    if (live?.phase.current === 'background') {
      live.phase.delivered();
      live.input.push(userMessage(text, attachments));
      return;
    }
    if (live) throw new Error('The agent is still working on the previous message.');
    this.stopping = false;
    const run: Run = { input: new InputChannel(), phase: new RunPhase(), abort: new AbortController(), midTurn: new MidTurnInput(), query: null, finished: Promise.resolve() };
    this.run = run;
    run.input.push(userMessage(text, attachments));
    // The run's terminal event (done/failed) is emitted only after the state is cleared, so a
    // listener that sends the next message straight away finds the handle idle.
    run.finished = this.execute(run).then((terminal) => {
      if (this.run === run) this.run = null;
      this.emit(terminal);
    });
  }

  /**
   * A message while the agent works: into the run's open input, which the CLI reads at once and folds
   * into the running turn at its next step (or runs as the next turn of this run). Not once the run is
   * ending, or quiet on background work (then `send` takes it).
   */
  async sendNow(message: MidTurnMessage): Promise<boolean> {
    const run = this.run;
    if (!run || this.stopping || run.input.isClosed || run.phase.current !== 'busy') return false;
    run.input.push(userMessage(message.text, message.attachments, run.midTurn.sent(message.id)));
    return true;
  }

  answer(requestId: string, answer: InputAnswer): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('That question is no longer waiting for an answer.');
    this.pending.delete(requestId);
    const level = pending.request.tool === 'ExitPlanMode' ? PLAN_LEVELS[answer.optionId ?? ''] : undefined;
    if (level) {
      // The plan is approved: this turn and the ones after it run at the level the user picked.
      this.opts = { ...this.opts, permission: level };
      this.emit({ type: 'mode', permission: level });
    }
    if (answer.optionId === ALLOW_OUTSIDE) {
      this.outsideAllowed = true;
      this.emit({ type: 'outside-allowed' });
    }
    pending.settle(resolution(pending, answer));
  }

  /**
   * End the run: the turn if one is going, and everything the agent left running in the background
   * with it (its process ends). The runtime offers this only while the agent is busy; quiet on
   * background work, the user stops each task from the strip instead.
   */
  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.stopping = true;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.settle({ behavior: 'deny', message: 'The user stopped this session.', interrupt: true });
    }
    run.input.close();
    run.abort.abort();
    await run.query?.interrupt().catch(() => undefined);
    await run.finished;
  }

  /** The handle is being replaced (new settings) or the session deleted: end the run, quietly. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
  }

  /** Background work runs inside the run's query; the SDK stops it and then lists it no more. Why it could not: stop-task.ts. */
  async stopBackgroundTask(taskId: string): Promise<void> {
    await stopClaudeTask(this.run?.query, taskId);
  }

  /** What one piece of background work printed. Only while the run lasts: the process holds the output. */
  async backgroundOutput(taskId: string): Promise<{ text: string; truncated: boolean }> {
    const query = this.run?.query;
    if (!query) throw new Error('The agent is no longer running, so it cannot be asked what the command printed.');
    return readTaskOutput(query, taskId);
  }

  private emit(event: AgentEvent): void {
    if (!this.closed) this.emitEvent(event);
  }

  /**
   * A confined session's command outside the sandbox that runs without a card: the user allowed them
   * all, or it is on the always-allowed list. Judged here too, on what will really run: when another
   * hook rewrote the call, Claude Code checks the rewritten command again and asks here, whatever
   * Kestrel's own hook answered (SDK 0.3.322).
   */
  private passesOutside(tool: string, input: Record<string, unknown>): boolean {
    const outside = (shellSandbox(this.opts) && isUnsandboxed(tool, input)) || isUnconfinedCommand(tool, input, this.opts);
    return outside ? this.outsideAllowed || onAllowList(input, this.opts) : false;
  }

  private canUseTool: CanUseTool = (tool, input, context) => {
    const written = this.written.get(context.toolUseID);
    this.written.delete(context.toolUseID);
    if (this.passesOutside(tool, input)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    // A command outside the sandbox first works out what its card may offer to always allow; every
    // other card goes out at once.
    if (!offersAllowList(tool, input, this.opts)) return this.ask(tool, input, context, {}, written);
    return cardOffer(tool, input, this.opts).then((offer) => this.ask(tool, input, context, offer, written));
  };

  private ask(tool: string, input: Record<string, unknown>, { signal, toolUseID }: Parameters<CanUseTool>[2], offer: SandboxOffer, written?: string): ReturnType<CanUseTool> {
    return new Promise((resolve) => {
      const id = toolUseID || randomUUID();
      const request = buildRequest(id, tool, input, this.opts.directory, this.planFile, this.opts.browserElement, offer, written, isUnconfinedCommand(tool, input, this.opts) ? unconfinedReason(this.opts) : null);
      const settle: Pending['settle'] = (result) => resolve(result);
      this.pending.set(id, { request, input, settle });
      signal.addEventListener('abort', () => {
        if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'The session was stopped.', interrupt: true });
      });
      this.emit({ type: 'needs-input', request });
    });
  }

  /** Sees every tool call before it runs. Connector tools are always refused, a read-only session
   *  is kept to the folders it may read, and rules plug in here. */
  private preToolUse: HookCallback = async (input) => {
    const name = String((input as { tool_name?: unknown }).tool_name ?? '');
    const toolInput = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
    const useId = (input as { tool_use_id?: unknown }).tool_use_id;
    const deny = (reason: string) => {
      if (typeof useId === 'string') this.refusals.set(useId, reason);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } };
    };
    if (isConnectorTool(name)) return deny('Kestrel sessions do not use claude.ai connectors; they can write to outside services.');
    const confined = confinementDenial(name, toolInput, { directory: this.opts.directory, readOnly: claudePermission(this.opts.permission).readOnly, readable: this.opts.readableDirectories ?? [] });
    if (confined) return deny(confined);
    const planFile = planFileWritten(name, toolInput);
    if (planFile) this.planFile = planFile;
    const verdict = await this.opts.intercept?.({ tool: name, input: toolInput });
    if (verdict && !verdict.allow) return deny(verdict.message);
    // Where an edit may go follows the mode: in the modes that pass edits by themselves, one
    // outside the session's folder becomes an approval card (canUseTool) instead.
    // A confined session's command that asks to leave the sandbox is always put to the user, in every mode.
    if (shellSandbox(this.opts) && isUnsandboxed(name, toolInput)) {
      if (typeof useId === 'string' && typeof toolInput.command === 'string') this.written.set(useId, toolInput.command);
      // ...unless the user said, on such a card, to allow them all for this session.
      if (this.outsideAllowed) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'The user allowed every command outside the sandbox for this session.' } };
      // ...or the command is on the user's always-allowed list (Settings → Workflow).
      if (onAllowList(toolInput, this.opts)) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: ON_LIST_NOTE } };
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'ask' as const, permissionDecisionReason: UNSANDBOXED_NOTE } };
    }
    // A confined session on a computer with no sandbox (Windows; Linux without bubblewrap): nothing
    // holds its commands to its folder, so each one is put to the user, with the same two ways past.
    if (isUnconfinedCommand(name, toolInput, this.opts)) {
      if (this.outsideAllowed) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'The user allowed every unsandboxed command for this session.' } };
      if (onAllowList(toolInput, this.opts)) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: ON_LIST_NOTE } };
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'ask' as const, permissionDecisionReason: unconfinedNote(unconfinedReason(this.opts)!) } };
    }
    if (asksOutsideFolder(this.opts.permission) && writeOutside(name, toolInput, this.opts.directory)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'ask' as const, permissionDecisionReason: OUTSIDE_NOTE } };
    }
    return {};
  };

  private options(abort: AbortController): Options {
    const base = baseOptions(this.opts);
    return {
      ...base,
      resume: this.sessionId ?? undefined,
      abortController: abort,
      // The user's servers first, so nothing they named can replace Kestrel's own.
      mcpServers: { ...(this.opts.setup?.mcpServers as Options['mcpServers']), kestrel: kestrelMcpServer(this.opts.tools) },
      hooks: { PreToolUse: [{ hooks: [this.preToolUse] }] },
      ...(shellSandbox(this.opts) ? { sandbox: shellSandbox(this.opts) } : {}),
      ...(claudePermission(this.opts.permission).readOnly ? {} : { canUseTool: this.canUseTool }),
    };
  }

  /** How full the context window is, as a turn ends; nothing when the SDK cannot say. */
  private async measureContext(current: Query): Promise<void> {
    const usage = await askContextUsage(current, CONTEXT_WAIT_MS);
    if (usage) this.emit({ type: 'context', usage });
  }

  /** What a change of phase means outside: the agent went quiet on background work or woke on its own; an ending run takes no more input. */
  private follow(run: Run, change: PhaseChange | null): void {
    if (change === 'over') run.input.close();
    else if (change) this.emit({ type: 'phase', phase: change });
  }

  /** Runs one run and returns how it ended. Never rejects. */
  private async execute(run: Run): Promise<AgentEvent> {
    const mapper = new ClaudeMapper(this.opts.directory, Object.keys(this.opts.setup?.mcpServers ?? {}), this.opts.browserElement);
    let outcome: Terminal | null = null;
    let started = false;
    const forward = (event: AgentEvent) => {
      // A run can hold several turns: the latest result carries the running cost, and a failure stands.
      if (event.type === 'done' || event.type === 'failed') {
        if (outcome?.type !== 'failed') outcome = event;
        return;
      }
      if (event.type === 'tool' && event.status === 'failed' && this.refusals.has(event.id)) {
        const refusal = this.refusals.get(event.id)!;
        this.refusals.delete(event.id);
        this.emit({ ...event, refusal });
        return;
      }
      if (event.type === 'started') {
        // Said once per run (the CLI may report itself again with each message it takes).
        if (started) return;
        started = true;
        this.sessionId = event.agentSessionId;
      }
      this.emit(event);
    };
    try {
      run.query = this.runQuery({ prompt: run.input, options: this.options(run.abort) });
      for await (const message of run.query) {
        const m = message as SdkLike;
        for (const event of mapper.map(m)) forward(event);
        const read = run.midTurn.see(m);
        if (read.length > 0) this.emit({ type: 'picked-up', ids: read });
        this.follow(run, run.phase.see(m, run.midTurn.moreToCome));
        // What can be asked for with "/": asked once per run, when the CLI first reports itself, and
        // replaced whenever the CLI says the list changed. Not waited for: the turn goes on.
        if (m.type === 'system' && m.subtype === 'init' && !run.commandsAsked) {
          run.commandsAsked = true;
          run.terminalOnly = leftOut(terminalOnlyOf({ terminal_slash_commands: m.terminal_slash_commands }));
          void askSlashCommands(run.query, run.terminalOnly).then((commands) => commands && this.emit({ type: 'slash-commands', commands }));
        } else if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands)) {
          this.emit({ type: 'slash-commands', commands: slashCommandsFrom(m.commands, run.terminalOnly ?? []) });
        }
        // A turn's result is in and its query still open: measure the context window now.
        if (m.type === 'result') await this.measureContext(run.query);
      }
    } catch (error) {
      // An error once the run was ending keeps the result already in; before that, it is how the run ended.
      if (!this.stopping && (run.phase.current !== 'over' || !outcome)) outcome = failure(error);
    } finally {
      run.input.close();
      this.written.clear();
      this.refusals.clear();
    }
    // Sent while it worked and never read: gone with the process, so Kestrel holds them again.
    const unread = run.midTurn.unread();
    if (unread.length > 0) this.emit({ type: 'unread', ids: unread });
    return this.ending(outcome);
  }

  /** The run's terminal event: stopped when the user stopped it (with what it cost), else how its last turn ended. */
  private ending(outcome: Terminal | null): AgentEvent {
    if (this.stopping) return { type: 'done', reason: 'stopped', ...(outcome?.type === 'done' && outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}) };
    return outcome ?? { type: 'failed', reason: 'The agent ended without finishing.', kind: 'other' };
  }
}

/** How a run ends. */
type Terminal = Extract<AgentEvent, { type: 'done' | 'failed' }>;

const failure = (error: unknown): Terminal => claudeThrown(error);

type Question = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };

/** What approving a plan can move the session to, by option id. */
const PLAN_LEVELS: Record<string, PermissionLevel> = { 'approve-edits': 'edits', 'approve-ask': 'ask' };
const PLAN_OPTIONS: InputRequest['options'] = [
  { id: 'approve-edits', label: 'Approve, accept edits', role: 'allow' },
  { id: 'approve-ask', label: 'Approve, ask before edits', role: 'allow' },
  { id: 'deny', label: 'Keep planning', role: 'deny' },
];

/** Where Claude Code writes plan files. (`plansDirectory` in flag settings did not move it when
 *  tried with an absolute path, and inside the project the plan would show as a change.) The
 *  hook notes the plan file written there, for the "Plan ready" card. */
export const CLAUDE_PLANS_DIR = join(homedir(), '.claude', 'plans');

/** The plan file a Write or Edit call targets, if it is one. */
export function planFileWritten(tool: string, input: Record<string, unknown>, plansDir = CLAUDE_PLANS_DIR): string | null {
  const path = input.file_path;
  if ((tool !== 'Write' && tool !== 'Edit') || typeof path !== 'string' || !path.endsWith('.md')) return null;
  return resolve(path).startsWith(plansDir + sep) ? resolve(path) : null;
}

/**
 * The plan to show. The SDK's ExitPlanMode call carries no plan of its own (its input schema has
 * only a deprecated field): the agent wrote it to a plan file first, which the hook noted.
 * Older versions passed it as `plan`, which is still taken when present.
 */
export function planText(input: Record<string, unknown>, planFile: string | null = null): string {
  if (typeof input.plan === 'string' && input.plan.trim()) return input.plan;
  const file = typeof input.planFilePath === 'string' ? input.planFilePath : planFile;
  try {
    return file ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

const questionsOf = (input: Record<string, unknown>): Question[] => (Array.isArray(input.questions) ? (input.questions as Question[]) : []);

function buildRequest(id: string, tool: string, input: Record<string, unknown>, cwd: string, planFile: string | null = null, element?: ElementLookup, offer: SandboxOffer = {}, written?: string, unconfined: string | null = null): InputRequest {
  if (tool === 'AskUserQuestion') {
    const questions = questionsOf(input).map((q) => ({ question: q.question, header: q.header, multi: q.multiSelect === true, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })) }));
    const only = questions.length === 1 && !questions[0]!.multi ? questions[0]! : null;
    return {
      id,
      kind: 'question',
      tool,
      title: 'Claude is asking you',
      detail: questions[0]?.question ?? '',
      questions,
      // One single-choice question is answered with one click; anything more is filled in and submitted.
      options: (only?.options ?? []).map((o, i) => ({ id: String(i), label: o.label, role: 'choice' as const })),
    };
  }
  if (tool === 'ExitPlanMode') return { id, kind: 'approval', tool, title: 'Plan ready', detail: planText(input, planFile), markdown: true, options: PLAN_OPTIONS };
  const { title, detail } = describeApproval(tool, input, cwd, element);
  const outside = writeOutside(tool, input, cwd);
  // An edit outside the session's folder says so, with the full path, above what it would write.
  if (outside) return { id, kind: 'approval', tool, title: `${tool === 'Write' ? 'Write' : 'Edit'} ${outside}`, detail: `${OUTSIDE_NOTE}.\n\n${detail}`, options: ALLOW };
  // A command that would run outside the sandbox says so above the command.
  // It may also offer to put the command, or the folder it names, on the always-allowed list.
  if (isUnsandboxed(tool, input)) {
    const always = offerOptions(offer);
    const options = [ALLOW[0]!, ...always, ...ALLOW_OR_ALL_OUTSIDE.slice(1)];
    return { id, kind: 'approval', tool, title: `${title} (outside the sandbox)`, detail: `${UNSANDBOXED_NOTE}.\n\n${rewrittenDetail(input, written) ?? detail}`, options, ...(always.length ? { sandboxOffer: offer } : {}) };
  }
  // A command of a confined session on a computer with no sandbox: the card says why it asks, and
  // offers to stop asking for this session, as the card for leaving the sandbox does.
  if (unconfined) {
    const options = [ALLOW[0]!, { id: ALLOW_OUTSIDE, label: 'Allow all commands in this session', role: 'allow' as const }, ALLOW[1]!];
    return { id, kind: 'approval', tool, title: `${title} (not sandboxed)`, detail: `${unconfinedNote(unconfined)}.\n\n${detail}`, options };
  }
  return { id, kind: 'approval', tool, title, detail, options: ALLOW };
}


function resolution(pending: Pending, answer: InputAnswer): Awaited<ReturnType<CanUseTool>> {
  const { request, input } = pending;
  if (request.kind === 'question') {
    const first = questionsOf(input)[0]?.question ?? '';
    const label = request.options.find((o) => o.id === answer.optionId)?.label ?? answer.text ?? '';
    return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers ?? { [first]: label } } };
  }
  if (answer.optionId === 'deny') return { behavior: 'deny', message: answer.text ? `The user declined: ${answer.text}` : request.tool === 'ExitPlanMode' ? 'The user wants to keep planning. Ask what to change.' : 'The user declined this action.', interrupt: false };
  const level = request.tool === 'ExitPlanMode' ? PLAN_LEVELS[answer.optionId ?? ''] : undefined;
  if (level) return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: claudePermission(level).permissionMode, destination: 'session' }] };
  return { behavior: 'allow', updatedInput: input };
}

/** `runQuery` is the SDK's `query` and `runFork` its `forkSession`; tests pass scripted ones. */
export function claudeAdapter(runQuery: typeof query = query, runFork: typeof forkSession = forkSession): AgentAdapter {
  return {
    agent: 'claude',
    availability: async () => claudeAvailability(),
    models: () => claudeModels(runQuery),
    start(options, prompt, emit, attachments) {
      const handle = new ClaudeHandle(null, options, emit, runQuery);
      handle.send(prompt, attachments);
      return handle;
    },
    resume: (agentSessionId, options, emit) => new ClaudeHandle(agentSessionId, options, emit, runQuery),
    // The SDK copies the transcript into a new session file with fresh ids (nothing runs). It is looked
    // up in the old session's folder; a resume from the fork's own worktree finds it there. From an
    // earlier turn, the copy ends at that turn's last message (`upToMessageId`, inclusive).
    fork: async (agentSessionId, where) => (await runFork(agentSessionId, { dir: where.from, ...(where.at ? { upToMessageId: where.at } : {}) })).sessionId,
    permissions: PERMISSION_LEVELS.map((l) => l.id),
    contextUsage: (agentSessionId, options) => claudeContextUsage(agentSessionId, options, runQuery),
    slashCommands: (options) => claudeSlashCommands(options, runQuery),
  };
}
