// Claude SDK message -> Kestrel AgentEvent. Pure: no I/O, no SDK calls, so it is tested on
// recorded messages (fixtures/). One mapper per turn; it keeps the little state it needs.
//
// Ids: a text event is keyed by API message id plus content-block index, so two text blocks of
// one message are two messages. The SDK sends one `assistant` message per content block, so the
// block index of a final message is the count of blocks already seen for that message id.
// Anything with a `parent_tool_use_id` belongs to a sub-agent (Task tool): it is not the main
// conversation, so only its file changes are noticed.
import { limitsFromEvent, tokensFromResult } from './usage.ts';
import { KESTREL_TOOLS, type AgentEvent, type KestrelToolsStatus } from '../types.ts';
import type { TodoItem } from '../../model.ts';
import { clip, editedFile, mayChangeFiles, summarizeTool, type ElementLookup } from './describe.ts';
import { pathsInside } from '../edited-paths.ts';
import { claudeFailure } from './failure.ts';
import { backgroundKind, type BackgroundTask } from '../../shared/background-tasks.ts';
import { serverStates, type AgentServerReport, type HandedServer, type McpServerState } from '../../shared/mcp-servers.ts';

/** The server name and tool Kestrel gives every session. */
export const KESTREL_SERVER = 'kestrel';
export const kestrelToolName = (name: string) => `mcp__${KESTREL_SERVER}__${name}`;
export const LIST_PROJECTS_TOOL = kestrelToolName('list_projects');
/** Every Kestrel tool as Claude spells it. */
export const ALL_KESTREL_TOOLS = KESTREL_TOOLS.map(kestrelToolName);

/** The few fields of the SDK's messages this file reads. Everything else is ignored. */
export interface SdkLike {
  type: string;
  subtype?: string;
  [key: string]: any;
}

const RESULT_LIMIT = 2000;

/** `connected` only when the server is up and every Kestrel tool is present; else which are missing. */
export function kestrelToolsCheck(init: SdkLike): { status: KestrelToolsStatus; missing: string[] } {
  const server = (init.mcp_servers ?? []).find((s: any) => s.name === KESTREL_SERVER);
  const tools: string[] = init.tools ?? [];
  const missing = KESTREL_TOOLS.filter((t) => !tools.includes(kestrelToolName(t))) as string[];
  const up = server?.status === 'connected';
  return { status: up && missing.length === 0 ? 'connected' : 'missing', missing: up ? missing : [...KESTREL_TOOLS] };
}

export const kestrelToolsStatus = (init: SdkLike): KestrelToolsStatus => kestrelToolsCheck(init).status;

/**
 * Tool servers (or their tools) in the session that are neither Kestrel's nor ones the user
 * switched on for this project (`expected`), as a visible warning.
 */
export function unexpectedTools(init: SdkLike, expected: readonly string[] = []): string | undefined {
  // A tool's name spells its server with anything but letters, digits, `_` and `-` turned into
  // `_` ("Home Assistant" becomes `mcp__Home_Assistant__…`), so both spellings are known.
  const known = new Set([KESTREL_SERVER, ...expected, ...expected.map((name) => name.replace(/[^a-zA-Z0-9_-]/g, '_'))]);
  const servers = (init.mcp_servers ?? []).filter((s: any) => !known.has(s.name)).map((s: any) => s.name as string);
  const others = (init.tools ?? []).filter((t: string) => t.startsWith('mcp__') && !known.has(t.split('__')[1]!));
  if (servers.length === 0 && others.length === 0) return undefined;
  const names = [...new Set([...servers, ...others.map((t: string) => t.split('__')[1]!)])];
  return `This session carries tool servers Kestrel did not add: ${names.join(', ')}. Connector tools are refused, but they should not be here.`;
}

/** Claude's word for a server's state (`init.mcp_servers[].status`), as Kestrel's. */
const CLAUDE_STATE: Record<string, AgentServerReport['state']> = { connected: 'connected', pending: 'starting', failed: 'failed', 'needs-auth': 'needs-sign-in' };

/** Kestrel's own servers in a Claude session, from its `init` message. Pure. */
export function claudeServerStates(init: SdkLike, handed: readonly HandedServer[] | undefined): McpServerState[] {
  const reports = new Map<string, AgentServerReport>();
  for (const s of init.mcp_servers ?? []) {
    if (typeof s?.name !== 'string') continue;
    reports.set(s.name, { state: CLAUDE_STATE[s.status] ?? 'unknown', ...(typeof s.error === 'string' && s.error ? { reason: s.error } : {}) });
  }
  return serverStates(handed, 'claude', reports);
}

/** Tools that only keep the agent's task list: shown as the list itself, not as a step. */
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);
const todoStatus = (value: unknown): TodoItem['status'] => (TODO_STATUS.has(value as string) ? (value as TodoItem['status']) : 'pending');

/** Pictures in a tool result (a screenshot, an image file that was read). */
function resultImages(content: unknown): { mediaType: string; data: string }[] {
  if (!Array.isArray(content)) return [];
  return content.filter((c: any) => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string').map((c: any) => ({ mediaType: String(c.source.media_type ?? 'image/png'), data: c.source.data as string }));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'tool_reference' ? `(loaded ${c.tool_name})` : '')).join('');
}

/** What the tool call that started a piece of background work said it does, and the command it ran. */
export interface ToolOrigin {
  label?: string;
  command?: string;
}

/** The parts of a tool call's input that name background work: the model's `description` and the `command`. Pure. */
export function toolOrigin(input: Record<string, unknown>): ToolOrigin | null {
  const label = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  return label || command ? { ...(label ? { label } : {}), ...(command ? { command } : {}) } : null;
}

/**
 * The background work worth listing from the SDK's task list: not ambient, not a helper, with an id
 * to stop it by, and with what the tool call that started it said (`origin`, by task id). Pure.
 */
export function listedTasks(tasks: readonly any[], origin: (taskId: string) => ToolOrigin | undefined = () => undefined, toolOf: (taskId: string) => string | undefined = () => undefined): BackgroundTask[] {
  return tasks.flatMap((t) => {
    if (t?.ambient === true || typeof t?.task_id !== 'string' || !t.task_id) return [];
    const kind = backgroundKind(typeof t.task_type === 'string' ? t.task_type : '');
    const toolId = toolOf(t.task_id);
    return kind ? [{ id: t.task_id, kind, description: typeof t.description === 'string' ? t.description : '', ...origin(t.task_id), ...(toolId ? { toolId } : {}) }] : [];
  });
}

const ENDINGS = new Set(['completed', 'failed', 'stopped']);

/** How a piece of background work ended, from its task_notification. Pure. */
export function taskEnded(m: SdkLike): AgentEvent[] {
  if (typeof m.task_id !== 'string' || !ENDINGS.has(m.status)) return [];
  const outputFile = typeof m.output_file === 'string' && m.output_file ? m.output_file : undefined;
  return [{ type: 'background-ended', taskId: m.task_id, status: m.status, ...(outputFile ? { outputFile } : {}) }];
}

/**
 * The output file a backgrounded shell call's result names ("Output is being written to: <path>.
 * You will be notified…"). Pure; undefined when it names none.
 */
export function backgroundOutputFile(result: string): string | undefined {
  return /Output is being written to:\s+(\/\S+?\.output)(?=[.,;]?(\s|$))/.exec(result)?.[1];
}

/** The shell tool: its calls are commands, listed in the Commands pane. */
const SHELL_TOOL = 'Bash';

/** Task messages that say which tool call (`tool_use_id`) started a task. */
const TASK_EVENTS = new Set(['task_started', 'task_progress', 'task_notification']);

export class ClaudeMapper {
  private streamMessageId: string | null = null;
  /** The SDK's latest list of background work, as it sent it. */
  private background: readonly any[] = [];
  /** What each tool call that may start background work said, by tool call id. */
  private readonly origins = new Map<string, ToolOrigin>();
  /** The tool call that started each task, by task id (from the task_* messages). */
  private readonly taskTools = new Map<string, string>();
  /** Streamed text so far, per content-block index of the current API message. */
  private streamed = new Map<number, string>();
  private readonly blocksSeen = new Map<string, number>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolSummaries = new Map<string, string>();
  /** The files each edit call writes, relative to the working folder, for both of its tool events. */
  private readonly toolPaths = new Map<string, string[]>();
  /** Shell tool calls sent to the background, by tool call id. */
  private readonly inBackground = new Set<string>();
  /** Subject of each task being created, by tool call, until the result gives the task its id. */
  private readonly creating = new Map<string, string>();
  /** The uuid of the latest message of the main conversation: where the turn ends, once its result is in (Fork). */
  private lastUuid: string | null = null;

  constructor(
    private readonly cwd: string,
    /** MCP servers the user switched on for this session's project; they are meant to be here. */
    private readonly expectedServers: readonly string[] = [],
    /** Names of browser-pane elements, so a click reads "Click “Sign in”". */
    private readonly element?: ElementLookup,
    /** Kestrel's own MCP servers handed to this session, for the header. */
    private readonly handed?: readonly HandedServer[],
  ) {}

  map(m: SdkLike): AgentEvent[] {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'background_tasks_changed') return this.backgroundChanged(m);
        if (m.subtype === 'task_notification') return [...this.taskOrigin(m), ...taskEnded(m)];
        if (TASK_EVENTS.has(m.subtype ?? '')) return this.taskOrigin(m);
        return m.subtype === 'init' ? [this.started(m)] : [];
      case 'stream_event':
        return m.parent_tool_use_id ? [] : this.stream(m);
      case 'assistant':
        this.noteUuid(m);
        return this.assistant(m);
      case 'user':
        this.noteUuid(m);
        return this.user(m);
      case 'result':
        return [...this.turnPoint(), ...this.result(m)];
      case 'rate_limit_event': {
        // The account's plan usage, as the CLI read it from the response (usage.ts).
        const usage = limitsFromEvent(m);
        return usage ? [{ type: 'limits', usage }] : [];
      }
      default:
        return [];
    }
  }

  private started(m: SdkLike): AgentEvent {
    const servers = (m.mcp_servers ?? []).map((s: any) => `${s.name}: ${s.status}`).join(', ');
    const check = kestrelToolsCheck(m);
    return { type: 'started', agentSessionId: m.session_id, model: m.model, kestrelTools: check.status, missing: check.missing, detail: servers, warning: unexpectedTools(m, this.expectedServers), ...(this.handed?.length ? { mcpServers: claudeServerStates(m, this.handed) } : {}) };
  }

  /** The SDK's full list of live background work replaces ours; it goes out whole (helpers left out: they have their own card). */
  private backgroundChanged(m: SdkLike): AgentEvent[] {
    this.background = Array.isArray(m.tasks) ? m.tasks : [];
    return [this.backgroundList()];
  }

  /**
   * A task_* message ties a task to the tool call that started it. The list can arrive before it
   * (the SDK lists a task before its task_started), so a listed task that just got its name is sent again.
   */
  private taskOrigin(m: SdkLike): AgentEvent[] {
    const taskId = m.task_id;
    const toolId = m.tool_use_id;
    if (typeof taskId !== 'string' || typeof toolId !== 'string' || this.taskTools.get(taskId) === toolId) return [];
    this.taskTools.set(taskId, toolId);
    const listed = this.background.some((t) => t?.task_id === taskId);
    return listed && this.origins.has(toolId) ? [this.backgroundList()] : [];
  }

  private backgroundList(): AgentEvent {
    const origin = (taskId: string) => this.origins.get(this.taskTools.get(taskId) ?? '');
    return { type: 'background-tasks', tasks: listedTasks(this.background, origin, (taskId) => this.taskTools.get(taskId)) };
  }

  private stream(m: SdkLike): AgentEvent[] {
    const e = m.event;
    if (e?.type === 'message_start') {
      this.streamMessageId = e.message?.id ?? null;
      this.streamed = new Map();
      return [];
    }
    if (e?.type === 'content_block_start') {
      const kind = e.content_block?.type;
      if (kind === 'thinking' || kind === 'redacted_thinking') return [{ type: 'status', text: 'Thinking…' }];
      if (kind === 'text') return [{ type: 'status', text: 'Writing…' }];
      return [];
    }
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.streamMessageId) {
      const index = e.index as number;
      const text = (this.streamed.get(index) ?? '') + e.delta.text;
      this.streamed.set(index, text);
      return [{ type: 'message', id: `${this.streamMessageId}:${index}`, text, delta: e.delta.text, done: false }];
    }
    return [];
  }

  private assistant(m: SdkLike): AgentEvent[] {
    const subAgent = Boolean(m.parent_tool_use_id);
    if (m.error && !subAgent) return [claudeFailure(resultText(m.message?.content) || String(m.error), String(m.error))];
    const events: AgentEvent[] = [];
    const messageId = m.message?.id as string;
    const content: any[] = m.message?.content ?? [];
    const base = this.blocksSeen.get(messageId) ?? 0;
    this.blocksSeen.set(messageId, base + content.length);
    content.forEach((block, i) => {
      if (block.type === 'tool_use') {
        const summary = summarizeTool(block.name, block.input ?? {}, this.cwd, this.element);
        const origin = toolOrigin(block.input ?? {});
        if (origin) this.origins.set(block.id, origin);
        this.toolNames.set(block.id, block.name);
        this.toolSummaries.set(block.id, summary);
        const paths = pathsInside(this.cwd, editedFile(block.name, block.input ?? {}));
        if (paths.length) this.toolPaths.set(block.id, paths);
        if (!subAgent && TASK_TOOLS.has(block.name)) events.push(...this.taskCall(block));
        else if (!subAgent) events.push({ type: 'tool', id: block.id, name: block.name, summary, status: 'started', ...this.shellCommand(block), ...(paths.length ? { paths } : {}) });
        else events.push({ type: 'subagent-output', id: String(m.parent_tool_use_id), text: `› ${summary}` });
      } else if (block.type === 'text' && block.text && !subAgent) {
        const index = base + i;
        const streamed = messageId === this.streamMessageId ? (this.streamed.get(index) ?? '') : '';
        const delta = block.text.startsWith(streamed) ? block.text.slice(streamed.length) : block.text;
        events.push({ type: 'message', id: `${messageId}:${index}`, text: block.text, delta, done: true });
      } else if (block.type === 'text' && block.text && subAgent) {
        events.push({ type: 'subagent-output', id: String(m.parent_tool_use_id), text: block.text });
      }
    });
    return events;
  }

  private user(m: SdkLike): AgentEvent[] {
    const content = m.message?.content;
    if (!Array.isArray(content)) return [];
    const subAgent = Boolean(m.parent_tool_use_id);
    const events: AgentEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const name = this.toolNames.get(block.tool_use_id) ?? '';
      const failed = block.is_error === true;
      if (!subAgent && TASK_TOOLS.has(name)) {
        const subject = this.creating.get(block.tool_use_id);
        const id = /#(\w+)/.exec(resultText(block.content))?.[1] ?? /"id"\s*:\s*"?(\w+)/.exec(resultText(block.content))?.[1];
        if (subject !== undefined && id && !failed) events.push({ type: 'task', id, text: subject, status: 'pending' });
        continue;
      }
      if (!subAgent) resultImages(block.content).forEach((image, i) => events.push({ type: 'image', id: `${block.tool_use_id}-${i}`, ...image }));
      if (!subAgent) events.push({ type: 'tool', id: block.tool_use_id, name, summary: this.toolSummaries.get(block.tool_use_id) ?? name, status: failed ? 'failed' : 'finished', detail: clip(resultText(block.content), RESULT_LIMIT), ...this.backgroundOf(block.tool_use_id, resultText(block.content)), ...this.pathsOf(block.tool_use_id) });
      else if (failed) events.push({ type: 'subagent-output', id: String(m.parent_tool_use_id), text: `✗ ${this.toolSummaries.get(block.tool_use_id) ?? name}: ${clip(resultText(block.content), 300)}` });
      if (!failed && mayChangeFiles(name)) events.push({ type: 'files-changed', paths: [] });
    }
    return events;
  }

  /** A backgrounded call's result: marked so, with the file its output goes to when the result names one. */
  private backgroundOf(id: string, result: string): { inBackground?: true; outputFile?: string } {
    if (!this.inBackground.has(id)) return {};
    const outputFile = backgroundOutputFile(result);
    return { inBackground: true, ...(outputFile ? { outputFile } : {}) };
  }

  /** The edited files of a tool call, as the `paths` of its event; nothing for a call that edits none. */
  private pathsOf(id: string): { paths?: string[] } {
    const paths = this.toolPaths.get(id);
    return paths ? { paths } : {};
  }

  /** A shell tool call's command line, its description and whether it was sent to the background; nothing for other tools. */
  private shellCommand(block: any): Pick<Extract<AgentEvent, { type: 'tool' }>, 'command' | 'label' | 'inBackground'> {
    const input = block.input ?? {};
    if (block.name !== SHELL_TOOL || typeof input.command !== 'string') return {};
    const background = input.run_in_background === true;
    if (background) this.inBackground.add(block.id);
    const label = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
    return { command: input.command, ...(label ? { label } : {}), ...(background ? { inBackground: true } : {}) };
  }

  /** A task-list tool call, as a change to the list. Creating a task waits for its id in the result. */
  private taskCall(block: any): AgentEvent[] {
    const input = block.input ?? {};
    if (block.name === 'TodoWrite' && Array.isArray(input.todos))
      return [{ type: 'todos', items: input.todos.map((t: any) => ({ text: String(t.content ?? ''), status: todoStatus(t.status) })) }];
    if (block.name === 'TaskCreate') this.creating.set(block.id, String(input.subject ?? ''));
    if (block.name === 'TaskUpdate' && input.taskId !== undefined)
      return [{ type: 'task', id: String(input.taskId), text: typeof input.subject === 'string' ? input.subject : undefined, status: input.status === 'deleted' ? 'deleted' : input.status === undefined ? undefined : todoStatus(input.status) }];
    return [];
  }

  /**
   * A message of the main conversation (not a helper's) carries the uuid it has in the transcript;
   * the last one before a turn's result is the turn's last chain entry, which `forkSession`'s
   * `upToMessageId` takes to copy the conversation through that turn.
   */
  private noteUuid(m: SdkLike): void {
    if (!m.parent_tool_use_id && typeof m.uuid === 'string' && m.uuid) this.lastUuid = m.uuid;
  }

  private turnPoint(): AgentEvent[] {
    return this.lastUuid ? [{ type: 'turn-point', point: this.lastUuid }] : [];
  }

  private result(m: SdkLike): AgentEvent[] {
    if (m.subtype === 'success' && !m.is_error) {
      const tokens = tokensFromResult(m);
      return [{ type: 'done', reason: 'complete', costUsd: m.total_cost_usd, ...(tokens ? { tokens } : {}) }];
    }
    const reason = String(m.result ?? (m.errors ?? []).join('; ') ?? m.subtype ?? 'The agent stopped with an error.') || String(m.subtype);
    return [claudeFailure(reason)];
  }
}
