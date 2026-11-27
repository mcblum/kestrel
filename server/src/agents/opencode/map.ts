// OpenCode server events (`event.subscribe`, opencode 1.14.25) -> Kestrel AgentEvents. Pure: no I/O,
// tested on recorded traffic (fixtures/). One mapper per session process; it keeps what the
// session's events need to be read: which messages are the assistant's, what kind each part is,
// the tool calls by call id, and which child sessions (sub-agents) belong to which task call.
//
// The event stream carries every session of the process's folder, so only the session's own
// events and its children's are read; the caller filters by `belongs`.
import { addTokens, realTokens, type TurnTokens } from '../../shared/plan-usage.ts';
import type { TodoItem } from '../../model.ts';
import { clip, type ElementLookup } from '../claude/describe.ts';
import { pathsInside } from '../edited-paths.ts';
import type { AgentEvent } from '../types.ts';
import { editedPaths, kestrelCall, summarize } from './tools.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const RESULT_LIMIT = 2000;
const STATUS_LIMIT = 160;

const TODO_STATUS: Readonly<Record<string, TodoItem['status']>> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' };

/** OpenCode's todo list as Kestrel's; cancelled items are left out. */
export function toTodos(todos: unknown): TodoItem[] {
  return (Array.isArray(todos) ? todos : [])
    .filter(isObj)
    .filter((t) => str(t.content) && t.status !== 'cancelled')
    .map((t) => ({ ...(str(t.id) ? { id: str(t.id) } : {}), text: str(t.content), status: TODO_STATUS[str(t.status)] ?? 'pending' }));
}

/** The words of an OpenCode error (`session.error`, an assistant message's `error`). */
export function errorText(error: unknown): string {
  if (!isObj(error)) return '';
  const data = isObj(error.data) ? error.data : {};
  return str(data.message) || str(error.name);
}

export interface ToolCall {
  tool: string;
  input: Obj;
  /** The session the call ran in: the main one, or a sub-agent's. */
  sessionID: string;
}

/** Totals of a turn, from its steps' `step-finish` parts. */
export interface TurnUsage {
  costUsd: number;
  /** Every step's tokens added up: input with cache reads and writes, output with reasoning. Null until a step reports any. */
  tokens: TurnTokens | null;
  /** The last step's input + cache read + output: what the conversation now occupies. */
  contextTokens: number;
}

export class OpencodeMapper {
  private readonly roles = new Map<string, string>();
  private readonly partKinds = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  /** Tool calls seen, by call id: a permission ask names the call. */
  readonly calls = new Map<string, ToolCall>();
  /** Child sessions (sub-agents) by session id -> the task call that started them. */
  private readonly children = new Map<string, string>();
  private readonly refused = new Map<string, string>();
  /** Where the session's project root is (`path.root` of its messages): OpenCode's ask patterns are relative to it. */
  root: string;
  /** The last error OpenCode reported for the session, for a failed turn's reason. */
  lastError: string | null = null;
  /** The final text of the last assistant message: a plan, in Plan. */
  lastText = '';
  usage: TurnUsage = { costUsd: 0, tokens: null, contextTokens: 0 };
  /** The model of the last assistant message, `provider/model`: whose context window the usage fills. */
  model = '';

  constructor(
    readonly sessionID: string,
    private readonly cwd: string,
    private readonly element?: ElementLookup,
  ) {
    this.root = cwd;
  }

  /** Whether an event's session is this one or one of its sub-agents. */
  belongs(sessionID: string): boolean {
    return sessionID === this.sessionID || this.children.has(sessionID);
  }

  /** The task call a child session works for; null for the main session. */
  taskOf(sessionID: string): string | null {
    return this.children.get(sessionID) ?? null;
  }

  /** Starts a new turn's totals and text. */
  beginTurn(): void {
    this.usage = { costUsd: 0, tokens: null, contextTokens: 0 };
    this.lastError = null;
    this.lastText = '';
  }

  /** Kestrel refused call `callID` for `reason`: it shows as failed with the reason, now and when OpenCode reports it. */
  refuse(callID: string, reason: string): AgentEvent[] {
    this.refused.set(callID, reason);
    const call = this.calls.get(callID);
    if (!call) return [];
    return [{ ...this.toolEvent(callID, call, 'failed'), detail: reason, refusal: reason }];
  }

  map(event: Obj): AgentEvent[] {
    const p = isObj(event.properties) ? event.properties : {};
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        return this.noteChild(isObj(p.info) ? p.info : {});
      case 'message.updated':
        return this.message(isObj(p.info) ? p.info : {});
      case 'message.part.updated':
        return isObj(p.part) ? this.part(p.part) : [];
      case 'message.part.delta':
        return this.delta(p);
      case 'todo.updated':
        return str(p.sessionID) === this.sessionID ? [{ type: 'todos', items: toTodos(p.todos) }] : [];
      case 'session.status':
        return this.status(p);
      case 'session.error':
        if (str(p.sessionID) === this.sessionID || !str(p.sessionID)) this.lastError = errorText(p.error) || this.lastError;
        return [];
      case 'session.compacted':
        return [{ type: 'status', text: 'Compacted the conversation' }];
      case 'file.edited':
        return str(p.file) ? [{ type: 'files-changed', paths: [str(p.file)] }] : [];
      default:
        return [];
    }
  }

  private noteChild(info: Obj): AgentEvent[] {
    const id = str(info.id);
    if (id && str(info.parentID) && this.belongs(str(info.parentID)) && !this.children.has(id)) {
      const task = [...this.calls.entries()].reverse().find(([, c]) => c.tool === 'task' && c.sessionID === str(info.parentID));
      this.children.set(id, task?.[0] ?? '');
    }
    return [];
  }

  private message(info: Obj): AgentEvent[] {
    this.roles.set(str(info.id), str(info.role));
    if (info.role !== 'assistant' || str(info.sessionID) !== this.sessionID) return [];
    const path = isObj(info.path) ? info.path : {};
    if (str(path.root)) this.root = str(path.root);
    if (str(info.providerID) && str(info.modelID)) this.model = `${str(info.providerID)}/${str(info.modelID)}`;
    if (info.error) this.lastError = errorText(info.error) || this.lastError;
    return [];
  }

  private part(part: Obj): AgentEvent[] {
    const id = str(part.id);
    this.partKinds.set(id, str(part.type));
    const sessionID = str(part.sessionID);
    if (!this.belongs(sessionID)) return [];
    const child = this.taskOf(sessionID);
    switch (part.type) {
      case 'text':
        return this.roles.get(str(part.messageID)) === 'assistant' && part.synthetic !== true ? this.text(id, part, child) : [];
      case 'reasoning':
        return child === null ? [{ type: 'status', text: 'Thinking…' }] : [];
      case 'tool':
        return this.tool(part, sessionID, child);
      case 'step-finish':
        return sessionID === this.sessionID ? this.step(part) : [];
      case 'retry':
        return [{ type: 'status', text: clip(`Retrying: ${errorText(part.error)}`, STATUS_LIMIT) }];
      case 'compaction':
        return [{ type: 'status', text: 'Compacting the conversation…' }];
      default:
        return [];
    }
  }

  private text(id: string, part: Obj, child: string | null): AgentEvent[] {
    const text = str(part.text);
    const done = isObj(part.time) && typeof part.time.end === 'number';
    if (child !== null) return done && text && child ? [{ type: 'subagent-output', id: child, text }] : [];
    const streamed = this.texts.get(id) ?? '';
    if (!text && !done) return [];
    if (done) {
      this.texts.delete(id);
      this.lastText = text;
      return text ? [{ type: 'message', id, text, delta: text.startsWith(streamed) ? text.slice(streamed.length) : text, done: true }] : [];
    }
    this.texts.set(id, text);
    return text === streamed ? [] : [{ type: 'message', id, text, delta: text.startsWith(streamed) ? text.slice(streamed.length) : text, done: false }];
  }

  private delta(p: Obj): AgentEvent[] {
    const id = str(p.partID);
    if (str(p.sessionID) !== this.sessionID || p.field !== 'text' || !str(p.delta)) return [];
    const kind = this.partKinds.get(id);
    if (kind === 'reasoning') return [{ type: 'status', text: 'Thinking…' }];
    if (kind !== 'text' || this.roles.get(str(p.messageID)) !== 'assistant') return [];
    const text = (this.texts.get(id) ?? '') + str(p.delta);
    this.texts.set(id, text);
    return [{ type: 'message', id, text, delta: str(p.delta), done: false }];
  }

  private toolEvent(callID: string, call: ToolCall, status: 'started' | 'finished' | 'failed'): Extract<AgentEvent, { type: 'tool' }> {
    const { name, input } = kestrelCall(call.tool, call.input);
    const paths = pathsInside(this.cwd, editedPaths(call.tool, call.input, this.cwd));
    const command = call.tool === 'bash' ? str(call.input.command) : '';
    return {
      type: 'tool',
      id: callID,
      name,
      summary: summarize(call.tool, call.input, this.cwd, this.element),
      status,
      ...(command ? { command, ...(str(input.description) ? { label: str(input.description) } : {}) } : {}),
      ...(paths.length ? { paths } : {}),
    };
  }

  private tool(part: Obj, sessionID: string, child: string | null): AgentEvent[] {
    const callID = str(part.callID) || str(part.id);
    const state = isObj(part.state) ? part.state : {};
    const call: ToolCall = { tool: str(part.tool), input: isObj(state.input) ? state.input : {}, sessionID };
    this.calls.set(callID, call);
    if (child !== null) return state.status === 'running' && child ? [{ type: 'subagent-output', id: child, text: summarize(call.tool, call.input, this.cwd) }] : [];
    switch (state.status) {
      case 'running':
        return [this.toolEvent(callID, call, 'started')];
      case 'completed':
        return this.completed(callID, call, state);
      case 'error': {
        const reason = this.refused.get(callID);
        return [{ ...this.toolEvent(callID, call, 'failed'), detail: clip(reason ?? str(state.error), RESULT_LIMIT), ...(reason ? { refusal: reason } : {}) }];
      }
      default:
        return [];
    }
  }

  private completed(callID: string, call: ToolCall, state: Obj): AgentEvent[] {
    const pictures = (Array.isArray(state.attachments) ? state.attachments : []).filter(isObj).flatMap((a, i) => {
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(str(a.url));
      return data ? [{ type: 'image' as const, id: `${callID}-${i}`, mediaType: data[1]!, data: data[2]! }] : [];
    });
    const changed = call.tool === 'bash' || editedPaths(call.tool, call.input, this.cwd).length > 0;
    const todos: AgentEvent[] = call.tool === 'todowrite' && Array.isArray(call.input.todos) ? [{ type: 'todos', items: toTodos(call.input.todos) }] : [];
    return [
      ...pictures,
      ...todos,
      { ...this.toolEvent(callID, call, 'finished'), detail: clip(str(state.output), RESULT_LIMIT) },
      ...(changed ? [{ type: 'files-changed' as const, paths: editedPaths(call.tool, call.input, this.cwd) }] : []),
    ];
  }

  private step(part: Obj): AgentEvent[] {
    const tokens = isObj(part.tokens) ? part.tokens : {};
    const cache = isObj(tokens.cache) ? tokens.cache : {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const cost = n(part.cost);
    const step = realTokens({ input: n(tokens.input) + n(cache.read) + n(cache.write), output: n(tokens.output) + n(tokens.reasoning) });
    this.usage = { costUsd: this.usage.costUsd + cost, tokens: addTokens(this.usage.tokens, step), contextTokens: n(tokens.input) + n(cache.read) + n(cache.write) + n(tokens.output) || this.usage.contextTokens };
    return [];
  }

  private status(p: Obj): AgentEvent[] {
    if (str(p.sessionID) !== this.sessionID || !isObj(p.status)) return [];
    if (p.status.type === 'retry') return [{ type: 'status', text: clip(`Retrying: ${str(p.status.message)}`, STATUS_LIMIT) }];
    return [];
  }
}
