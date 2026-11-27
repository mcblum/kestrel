// Builds the conversation shown in the UI from adapter events. Pure and immutable: each call
// returns a new message list plus the messages that changed, which is all the live channel sends.
import type { ReviewReply } from './shared/review-reply.ts';
import type { ReviewEnd, RoundFindings } from './shared/round-findings.ts';
import type { AgentEvent, InputRequest } from './agents/types.ts';
import type { Attachment, ChatActivity, ChatMessage, FileCard, NextStep, StartedSession, TodoItem, WidgetCard } from './model.ts';
import type { Suggestion } from './shared/suggestions.ts';
import { endTurn, markForkPoint } from './shared/turns.ts';
import { noteLine, type MessageFrom } from './shared/notes.ts';

export type TranscriptAction =
  | AgentEvent
  /** The user's message. `midTurn`: sent into the running turn, not starting one (shared/mid-turn.ts). */
  | { type: 'user'; id: string; text: string; attachments?: readonly Attachment[]; midTurn?: boolean; byAgent?: true }
  /** Messages taken back out: sent into a turn that ended before the agent read them, and held again. */
  | { type: 'withdrawn'; ids: readonly string[] }
  /** The user answered (or the request was abandoned); `label` says how. */
  | { type: 'resolved'; requestId: string; label: string }
  /** A restart or stop ended the turn: nothing is streaming any more. */
  | { type: 'settled' }
  /** Something to show as its own card: a widget, a file, a next step, pictures, an optional action. */
  | { type: 'card'; id: string; widget?: WidgetCard; file?: FileCard; next?: NextStep; review?: ReviewReply; roundFindings?: RoundFindings; reviewEnd?: ReviewEnd; started?: StartedSession; images?: string[]; suggestion?: Suggestion; at?: number }
  /** A line from Kestrel itself (a refusal, a message from another session). `startsTurn`: the agent was woken with it. */
  | { type: 'notice'; id: string; text: string; level: 'info' | 'warning' | 'error'; startsTurn?: boolean }
  /**
   * A note from another session (shared/notes.ts), shown as a quiet line "From <title>: …". `midTurn`:
   * it went into the running turn; otherwise it went with the turn that is starting.
   */
  | { type: 'note'; id: string; from: MessageFrom; midTurn?: boolean };

export interface Applied {
  messages: ChatMessage[];
  changed: ChatMessage[];
  /** Ids taken out of their place; one that is also in `changed` was moved to the end (`reviewLast`). */
  removed?: string[];
}

const MAX_OUTPUT = 20_000;

function activityFor(tool: Extract<AgentEvent, { type: 'tool' }>): ChatActivity {
  const status = tool.status === 'started' ? 'running' : tool.status === 'failed' ? 'failed' : 'done';
  const icon = tool.name === 'Bash' ? 'terminal' : tool.name === 'Write' || tool.name === 'Edit' || tool.name === 'MultiEdit' ? 'file-diff' : 'check';
  // A refusal or warning, once said, stays: a later event about the same call (Codex reporting the change declined) does not clear it.
  return { id: tool.id, icon, text: tool.summary, status, detail: tool.detail, ...(tool.paths?.length ? { paths: tool.paths } : {}), ...(tool.refusal ? { refusal: tool.refusal } : {}), ...(tool.warning ? { warning: tool.warning } : {}) };
}

function cardFor(request: InputRequest): ChatMessage['input'] {
  return { id: request.id, kind: request.kind, title: request.title, detail: request.detail, tool: request.tool, options: request.options, ...(request.markdown ? { markdown: true } : {}), ...(request.questions ? { questions: request.questions } : {}), ...(request.sandboxOffer ? { sandboxOffer: request.sandboxOffer } : {}), ...(request.kestrel ? { kestrel: true as const } : {}) };
}

/**
 * The task list lives in one message, changed in place while the user has said nothing since.
 * After a new user message the list moves to a fresh message at the end, so it sits with the
 * work it describes; a finished list is left behind as it was.
 */
function withTodos(messages: readonly ChatMessage[], time: string, change: (current: TodoItem[]) => TodoItem[]): Applied {
  const index = messages.findLastIndex((m) => m.todos);
  const lastUser = messages.findLastIndex((m) => m.author === 'you');
  const current = index >= 0 ? messages[index]!.todos! : [];
  if (index > lastUser) {
    const message = { ...messages[index]!, todos: change(current) };
    return { messages: replaceAt(messages, index, message), changed: [message] };
  }
  const carried = current.every((t) => t.status === 'completed') ? [] : current;
  const message: ChatMessage = { id: `todos-${messages.length}-${time}`, author: 'agent', time, text: '', todos: change(carried) };
  return { messages: [...messages, message], changed: [message] };
}

function upsertTask(items: TodoItem[], task: Extract<AgentEvent, { type: 'task' }>): TodoItem[] {
  const { id, text, status } = task;
  if (status === 'deleted') return items.filter((t) => t.id !== id);
  if (!items.some((t) => t.id === id)) return [...items, { id, text: text ?? `Task ${id}`, status: status ?? 'pending' }];
  return items.map((t) => (t.id === id ? { ...t, text: text ?? t.text, status: status ?? t.status } : t));
}

/** A message that is a card of its own (task list, widget, file, next step, pictures, suggestion): tool lines do not join it. */
const isCard = (m: ChatMessage) => Boolean(m.input || m.notice || m.todos || m.widget || m.file || m.next || m.review || m.roundFindings || m.reviewEnd || m.started || m.images || m.suggestion);

const replaceAt = <T>(list: readonly T[], index: number, item: T): T[] => list.map((x, i) => (i === index ? item : x));

/**
 * The live status line an event leaves behind: a few words while the agent works, '' when it
 * stops or waits for the user, undefined when the event says nothing about it.
 */
export function liveStatus(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'status':
      return event.text;
    case 'started':
      return 'Thinking…';
    case 'tool':
      return event.status === 'started' ? `${event.summary}…` : 'Thinking…';
    case 'phase':
      // Quiet on background work is not working: the strip says what still runs.
      return event.phase === 'background' ? '' : 'Thinking…';
    case 'needs-input':
    case 'done':
    case 'failed':
      return '';
    default:
      return undefined;
  }
}

/**
 * `time` is the clock text shown on a message; `now` (ms since 1970) stamps when a turn starts and
 * ends (shared/turns.ts). Without `now` nothing is stamped.
 */
const NONE_KEPT: ReadonlySet<string> = new Set();

/**
 * `keepOpen`: the ids of cards that stay open when the turn ends, because their answer still does
 * something: Kestrel's own cards (delegate, move, a review), which a tool call of Kestrel's is
 * waiting on whatever became of the agent's turn (Matt, 2026-11-23).
 */
export function applyToTranscript(messages: readonly ChatMessage[], action: TranscriptAction, time: string, now?: number, keepOpen: ReadonlySet<string> = NONE_KEPT): Applied {
  const applied = applyAction(messages, action, time, now, keepOpen);
  return (action.type === 'message' || action.type === 'tool') && applied.messages.length > messages.length ? reviewLast(applied) : applied;
}

/**
 * A review is the last thing in its turn (Matt, 2026-11-21). The agent is told to end its turn with
 * post_review; when it says or does more all the same, that goes above the review card, which
 * stays at the foot of the turn. Only the newest turn (what follows the user's last message) is looked at.
 */
function reviewLast(applied: Applied): Applied {
  const { messages } = applied;
  const turnStart = messages.findLastIndex((m) => m.author === 'you' && !m.midTurn) + 1;
  const at = messages.findIndex((m, i) => i >= turnStart && m.review !== undefined);
  if (at < 0 || at === messages.length - 1) return applied;
  const card = messages[at]!;
  return { messages: [...messages.slice(0, at), ...messages.slice(at + 1), card], changed: [...applied.changed, card], removed: card.id === undefined ? [] : [card.id] };
}

function applyAction(messages: readonly ChatMessage[], action: TranscriptAction, time: string, now?: number, keepOpen: ReadonlySet<string> = NONE_KEPT): Applied {
  const sent = now === undefined ? {} : { sentAt: now };
  switch (action.type) {
    case 'user': {
      const message: ChatMessage = { id: action.id, author: 'you', time, text: action.text, ...(action.attachments?.length ? { attachments: [...action.attachments] } : {}), ...sent, ...(action.midTurn ? { midTurn: 'sent' as const } : {}), ...(action.byAgent ? { byAgent: true as const } : {}) };
      // The user has spoken: the reply buttons of earlier next steps are spent.
      const spent: ChatMessage[] = [];
      const before = messages.map((m) => {
        if (!m.next || m.next.done) return m;
        const closed = { ...m, next: { ...m.next, done: true } };
        spent.push(closed);
        return closed;
      });
      return { messages: [...before, message], changed: [...spent, message] };
    }
    case 'message': {
      const index = messages.findIndex((m) => m.id === action.id);
      const message: ChatMessage = { ...(index >= 0 ? messages[index]! : { id: action.id, author: 'agent' as const, time }), text: action.text, streaming: !action.done };
      return { messages: index >= 0 ? replaceAt(messages, index, message) : [...messages, message], changed: [message] };
    }
    case 'tool': {
      const item = activityFor(action);
      const owner = messages.findIndex((m) => m.activity?.some((a) => a.id === action.id));
      if (owner >= 0) {
        const current = messages[owner]!;
        const message = { ...current, activity: current.activity!.map((a) => (a.id === action.id ? { ...a, ...item, text: a.text || item.text } : a)) };
        return { messages: replaceAt(messages, owner, message), changed: [message] };
      }
      // A new tool use joins the latest agent message, or starts one.
      const last = messages.at(-1);
      if (last && last.author === 'agent' && !isCard(last)) {
        const message = { ...last, activity: [...(last.activity ?? []), item] };
        return { messages: replaceAt(messages, messages.length - 1, message), changed: [message] };
      }
      const message: ChatMessage = { id: `tools-${action.id}`, author: 'agent', time, text: '', activity: [item] };
      return { messages: [...messages, message], changed: [message] };
    }
    case 'needs-input': {
      const message: ChatMessage = { id: `input-${action.request.id}`, author: 'agent', time, text: '', input: cardFor(action.request) };
      return { messages: [...messages, message], changed: [message] };
    }
    case 'todos':
      return withTodos(messages, time, () => action.items);
    case 'task':
      return withTodos(messages, time, (current) => upsertTask(current, action));
    case 'card': {
      // A card sent again with the same id replaces the first (more pictures from one tool result).
      const index = messages.findIndex((m) => m.id === action.id);
      const before = index >= 0 ? messages[index]! : null;
      // A card sent again keeps when it first appeared (pictures are grouped by it).
      const at = before?.at ?? action.at;
      const message: ChatMessage = { id: action.id, author: 'agent', time: before ? before.time : time, text: '', ...(at !== undefined ? { at } : {}), ...(action.widget ? { widget: action.widget } : {}), ...(action.file ? { file: action.file } : {}), ...(action.next ? { next: action.next } : {}), ...(action.review ? { review: action.review } : {}), ...(action.roundFindings ? { roundFindings: action.roundFindings } : {}), ...(action.reviewEnd ? { reviewEnd: action.reviewEnd } : {}), ...(action.started ? { started: action.started } : {}), ...(action.images ? { images: action.images } : {}), ...(action.suggestion ? { suggestion: action.suggestion } : {}) };
      return { messages: index >= 0 ? replaceAt(messages, index, message) : [...messages, message], changed: [message] };
    }
    case 'note': {
      const message: ChatMessage = { id: action.id, author: 'agent', time, text: noteLine(action.from.title, action.from.body), notice: 'info', from: { sessionId: action.from.sessionId, title: action.from.title }, ...(action.midTurn ? { midTurn: 'sent' as const } : sent) };
      return { messages: [...messages, message], changed: [message] };
    }
    case 'notice': {
      const message: ChatMessage = { id: action.id, author: 'agent', time, text: action.text, notice: action.level, ...(action.startsTurn ? sent : {}) };
      return { messages: [...messages, message], changed: [message] };
    }
    case 'resolved': {
      const index = messages.findIndex((m) => m.input?.id === action.requestId);
      if (index < 0) return { messages: [...messages], changed: [] };
      const message = { ...messages[index]!, input: { ...messages[index]!.input!, resolved: action.label } };
      return { messages: replaceAt(messages, index, message), changed: [message] };
    }
    // The agent read messages sent into its turn: they say so.
    case 'picked-up': {
      const ids = new Set(action.ids);
      const changed: ChatMessage[] = [];
      const next = messages.map((m) => {
        if (m.id === undefined || !ids.has(m.id) || m.midTurn !== 'sent') return m;
        const read: ChatMessage = { ...m, midTurn: 'read' };
        changed.push(read);
        return read;
      });
      return { messages: next, changed };
    }
    case 'withdrawn': {
      const ids = new Set(action.ids);
      return { messages: messages.filter((m) => m.id === undefined || !ids.has(m.id)), changed: [] };
    }
    // A start warning (tool servers Kestrel did not add) goes to the agent output log, not the chat.
    case 'started':
      return { messages: [...messages], changed: [] };
    case 'failed': {
      const message: ChatMessage = { id: `failed-${time}-${messages.length}`, author: 'agent', time, text: action.reason, notice: 'error', ...(action.kind === 'auth' ? { signIn: true as const } : {}) };
      const settled = ended(settle(messages, 'done', keepOpen), now);
      return { messages: [...settled.messages, message], changed: [...settled.changed, message] };
    }
    case 'done':
      return ended(settle(messages, action.reason === 'stopped' ? 'stopped' : 'done', keepOpen), now);
    // The agent finished talking and only waits on background work: for the user the turn is over.
    case 'phase':
      return action.phase === 'background' ? ended(settle(messages, 'done', keepOpen), now) : { messages: [...messages], changed: [] };
    case 'settled':
      return settle(messages, 'done', keepOpen);
    // Where the turn ends in the agent's own conversation: kept on the message that started it, for Fork.
    case 'turn-point': {
      const marked = markForkPoint(messages, action.point);
      return marked ? { messages: replaceAt(messages, marked.index, marked.message), changed: [marked.message] } : { messages: [...messages], changed: [] };
    }
    default:
      return { messages: [...messages], changed: [] };
  }
}

/** The turn is over at `now`: stamped on the message that started it. */
function ended(applied: Applied, now: number | undefined): Applied {
  if (now === undefined) return applied;
  const stamped = endTurn(applied.messages, now);
  if (!stamped) return applied;
  const messages = applied.messages.map((m, i) => (i === stamped.index ? stamped.message : m));
  return { messages, changed: [...applied.changed.filter((m) => m.id !== stamped.message.id), stamped.message] };
}

/** What a card still open when its turn ended says: nothing can answer it any more. */
export const UNANSWERED_LABEL = 'Not answered (the turn ended)';

/**
 * Nothing is streaming or running after this: close open text and unfinished tool lines, and mark
 * cards nobody answered (a stop, a failure), so they no longer offer buttons that cannot work. A
 * tool line still running when the user stopped the turn ends as stopped, not done: it never finished.
 */
function settle(messages: readonly ChatMessage[], unfinished: 'done' | 'stopped' = 'done', keepOpen: ReadonlySet<string> = NONE_KEPT): Applied {
  const changed: ChatMessage[] = [];
  const next = messages.map((m) => {
    const open = Boolean(m.input && !m.input.resolved && !keepOpen.has(m.input.id));
    const stale = m.streaming || m.activity?.some((a) => a.status === 'running') || open;
    if (!stale) return m;
    const updated: ChatMessage = {
      ...m,
      streaming: false,
      activity: m.activity?.map((a) => (a.status === 'running' ? { ...a, status: unfinished } : a)),
      ...(open ? { input: { ...m.input!, resolved: UNANSWERED_LABEL } } : {}),
    };
    changed.push(updated);
    return updated;
  });
  return { messages: next, changed };
}

/** A line for the read-only "Agent output" pane. */
export function outputLine(event: AgentEvent): string | null {
  switch (event.type) {
    case 'started':
      return `[started] ${event.model} · Kestrel tools ${event.kestrelTools}${event.detail ? ` · ${event.detail}` : ''}${event.warning ? `\n[warning] ${event.warning}` : ''}`;
    case 'tool':
      return event.status === 'started' ? `› ${event.summary}` : event.status === 'failed' ? `✗ ${event.summary}: ${event.detail ?? ''}` : null;
    case 'needs-input':
      return `? ${event.request.title}`;
    case 'done':
      return event.reason === 'stopped' ? '[stopped]' : `[done]${event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : ''}`;
    case 'failed':
      return `[failed] ${event.reason}`;
    case 'phase':
      return event.phase === 'background' ? '[finished talking; work still running in the background]' : '[working again]';
    default:
      return null;
  }
}

export function appendOutput(current: string, line: string): string {
  const next = `${current}${line}\n`;
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
}
