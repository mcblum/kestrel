// Codex app-server notifications -> Kestrel AgentEvents. Pure: no I/O, so it is tested on recorded
// traffic (fixtures/). One mapper per turn; it keeps the little state the turn needs.
//
// Codex's items are named in Kestrel's (Claude's) tool vocabulary, so the conversation shows them
// the same way: a command is `Bash`, a file change `Write` or `Edit`, an MCP call
// `mcp__<server>__<tool>` (Kestrel's own tools then read "Open … in the browser" and so on).
import type { TodoItem } from '../../model.ts';
import { clip, shortPath, summarizeTool, type ElementLookup } from '../claude/describe.ts';
import type { AgentEvent } from '../types.ts';
import { pathsInside } from '../edited-paths.ts';

type Obj = Record<string, unknown>;
const RESULT_LIMIT = 2000;
const STATUS_LIMIT = 160;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One change of a `fileChange` item. */
export interface FileChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
  diff: string;
  /** Where an update moves the file to (`kind.move_path`), when it moves it. */
  movePath?: string;
}

export function fileChanges(item: Obj): FileChange[] {
  return list(item.changes)
    .filter(isObj)
    .map((c) => {
      const moved = isObj(c.kind) ? str(c.kind.move_path) : '';
      return { path: str(c.path), kind: (isObj(c.kind) && (c.kind.type === 'add' || c.kind.type === 'delete') ? c.kind.type : 'update') as FileChange['kind'], diff: str(c.diff), ...(moved ? { movePath: moved } : {}) };
    })
    .filter((c) => c.path);
}

/** The command as the user would type it: Codex wraps it in `/bin/zsh -lc '…'` and also reports it parsed. */
export function displayCommand(command: string, actions: unknown = []): string {
  const parsed = list(actions).filter(isObj);
  if (parsed.length === 1 && str(parsed[0]!.command)) return str(parsed[0]!.command);
  const wrapped = /^\/bin\/(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  return wrapped ? wrapped[1]!.replace(/'"'"'/g, "'") : command;
}

/** The tool name and summary for a file change, as Claude's Write/Edit would read. */
export function describeChanges(changes: readonly FileChange[], cwd: string): { name: string; summary: string } {
  const only = changes.length === 1 ? changes[0]! : null;
  const name = only?.kind === 'add' ? 'Write' : 'Edit';
  if (only) return { name, summary: `${only.kind === 'add' ? 'Write' : only.kind === 'delete' ? 'Delete' : 'Edit'} ${shortPath(only.path, cwd)}` };
  return { name, summary: `Edit ${changes.length} files` };
}

/** A file change's paths as the `paths` of its tool event (agents/edited-paths.ts). */
function pathsOf(changes: readonly FileChange[], cwd: string): { paths?: string[] } {
  const paths = pathsInside(cwd, changes.map((c) => c.path));
  return paths.length ? { paths } : {};
}

const mcpName = (item: Obj) => `mcp__${str(item.server)}__${str(item.tool)}`;

/** Text and pictures of an MCP tool result (`{content: [{type: 'text'|'image', …}]}`). */
export function mcpResult(result: unknown): { text: string; images: { mediaType: string; data: string }[] } {
  const content = isObj(result) ? list(result.content).filter(isObj) : [];
  const text = content.map((c) => (c.type === 'text' ? str(c.text) : '')).join('');
  const images = content.filter((c) => c.type === 'image' && typeof c.data === 'string').map((c) => ({ mediaType: str(c.mimeType) || 'image/png', data: str(c.data) }));
  return { text, images };
}

const PLAN_STATUS: Record<string, TodoItem['status']> = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

/** Codex's plan steps (`turn/plan/updated`) as Kestrel's task list. */
export function planTodos(plan: unknown): TodoItem[] {
  return list(plan)
    .filter(isObj)
    .map((s) => ({ text: str(s.step), status: PLAN_STATUS[str(s.status)] ?? 'pending' }))
    .filter((s) => s.text);
}

export class CodexMapper {
  /** Text so far of each agent message, by item id. */
  private readonly texts = new Map<string, string>();
  /** File changes by item id: an approval request names only the item. */
  readonly changes = new Map<string, FileChange[]>();
  /** Why Kestrel refused a file change, by item id: shown on the change instead of Codex's bare "declined". */
  private readonly refused = new Map<string, string>();
  /** The command of each command item, by item id, as shown to the user. */
  readonly commands = new Map<string, string>();
  /** The plan Codex wrote in plan mode (a `plan` item), if any. */
  plan: string | null = null;
  /** The last error Codex reported that it will not retry, for a failed turn's reason. */
  lastError: string | null = null;

  constructor(
    private readonly cwd: string,
    private readonly element?: ElementLookup,
  ) {}

  /** Kestrel refused file change `id` for `reason`: the change shows as failed with the reason, now and when Codex reports it declined. */
  refuse(id: string, reason: string): AgentEvent {
    this.refused.set(id, reason);
    return { ...this.changeEvent(id, this.changes.get(id) ?? []), status: 'failed', detail: reason, refusal: reason };
  }

  /** File change `id` as a tool row, with `note` as its detail: for one Codex applied that Kestrel would have refused. */
  note(id: string, changes: readonly FileChange[], note: string): AgentEvent {
    return { ...this.changeEvent(id, changes), status: 'finished', detail: note, warning: note };
  }

  private changeEvent(id: string, changes: readonly FileChange[]): Extract<AgentEvent, { type: 'tool' }> {
    const { name, summary } = describeChanges(changes, this.cwd);
    return { type: 'tool', id, name, summary, status: 'started', ...pathsOf(changes, this.cwd) };
  }

  map(method: string, params: Obj): AgentEvent[] {
    switch (method) {
      case 'item/started':
        return isObj(params.item) ? this.started(params.item) : [];
      case 'item/completed':
        return isObj(params.item) ? this.completed(params.item) : [];
      case 'item/agentMessage/delta':
        return this.delta(str(params.itemId), str(params.delta));
      // What a running command prints, as it prints it: the Commands pane shows it live.
      case 'item/commandExecution/outputDelta':
        return str(params.itemId) && str(params.delta) ? [{ type: 'tool-output', id: str(params.itemId), delta: str(params.delta) }] : [];
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return [{ type: 'status', text: 'Thinking…' }];
      case 'turn/plan/updated':
        return [{ type: 'todos', items: planTodos(params.plan) }];
      case 'item/autoApprovalReview/started':
        return [{ type: 'status', text: 'Codex is reviewing an action…' }];
      case 'guardianWarning':
        return str(params.message) ? [{ type: 'status', text: clip(str(params.message), STATUS_LIMIT) }] : [];
      case 'model/rerouted':
        return [{ type: 'status', text: `Codex switched to ${str(params.toModel) || 'another model'}` }];
      case 'error':
        return this.error(params);
      default:
        return [];
    }
  }

  private delta(id: string, delta: string): AgentEvent[] {
    if (!id || !delta) return [];
    const text = (this.texts.get(id) ?? '') + delta;
    this.texts.set(id, text);
    return [{ type: 'message', id, text, delta, done: false }];
  }

  private error(params: Obj): AgentEvent[] {
    const error = isObj(params.error) ? params.error : {};
    const message = str(error.message) || 'Codex reported an error.';
    if (params.willRetry === true) return [{ type: 'status', text: clip(`Retrying: ${message}`, STATUS_LIMIT) }];
    this.lastError = message;
    return [];
  }

  private started(item: Obj): AgentEvent[] {
    const id = str(item.id);
    switch (item.type) {
      case 'agentMessage':
        return [{ type: 'status', text: 'Writing…' }];
      case 'reasoning':
        return [{ type: 'status', text: 'Thinking…' }];
      case 'plan':
        return [{ type: 'status', text: 'Writing the plan…' }];
      case 'contextCompaction':
        return [{ type: 'status', text: 'Compacting the conversation…' }];
      case 'commandExecution': {
        const command = displayCommand(str(item.command), item.commandActions);
        this.commands.set(id, command);
        return [{ type: 'tool', id, name: 'Bash', summary: summarizeTool('Bash', { command }, this.cwd), status: 'started', command: str(item.command) || command }];
      }
      case 'fileChange': {
        const changes = fileChanges(item);
        this.changes.set(id, changes);
        const { name, summary } = describeChanges(changes, this.cwd);
        return [{ type: 'tool', id, name, summary, status: 'started', ...pathsOf(changes, this.cwd) }];
      }
      case 'mcpToolCall': {
        const name = mcpName(item);
        return [{ type: 'tool', id, name, summary: summarizeTool(name, isObj(item.arguments) ? item.arguments : {}, this.cwd, this.element), status: 'started' }];
      }
      case 'dynamicToolCall':
        return [{ type: 'tool', id, name: str(item.tool) || 'Tool', summary: str(item.tool) || 'A tool', status: 'started' }];
      case 'webSearch':
        return [{ type: 'tool', id, name: 'WebSearch', summary: clip(`Search the web${str(item.query) ? ` for ${str(item.query)}` : ''}`, STATUS_LIMIT), status: 'started' }];
      case 'imageView':
        return [{ type: 'tool', id, name: 'Read', summary: `Look at ${shortPath(str(item.path), this.cwd)}`, status: 'started' }];
      case 'collabAgentToolCall':
        return [{ type: 'tool', id, name: 'Agent', summary: clip(str(item.prompt) || 'Sub-agent', STATUS_LIMIT), status: 'started' }];
      default:
        return [];
    }
  }

  private completed(item: Obj): AgentEvent[] {
    const id = str(item.id);
    switch (item.type) {
      case 'agentMessage': {
        const text = str(item.text);
        const streamed = this.texts.get(id) ?? '';
        this.texts.delete(id);
        if (!text) return [];
        return [{ type: 'message', id, text, delta: text.startsWith(streamed) ? text.slice(streamed.length) : text, done: true }];
      }
      case 'plan':
        this.plan = str(item.text) || this.plan;
        return [];
      case 'commandExecution': {
        const command = this.commands.get(id) ?? displayCommand(str(item.command), item.commandActions);
        const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined);
        const output = str(item.aggregatedOutput) || (item.status === 'declined' ? 'Declined.' : '');
        return [
          { type: 'tool', id, name: 'Bash', summary: summarizeTool('Bash', { command }, this.cwd), status: ok ? 'finished' : 'failed', detail: clip(output, RESULT_LIMIT) },
          ...(item.status === 'declined' ? [] : [{ type: 'files-changed' as const, paths: [] }]),
        ];
      }
      case 'fileChange': {
        const changes = fileChanges(item);
        const { name, summary } = describeChanges(changes.length ? changes : (this.changes.get(id) ?? []), this.cwd);
        const ok = item.status === 'completed';
        return [
          { type: 'tool', id, name, summary, status: ok ? 'finished' : 'failed', detail: ok ? '' : (this.refused.get(id) ?? `The change was ${str(item.status) || 'not applied'}.`), ...(!ok && this.refused.has(id) ? { refusal: this.refused.get(id)! } : {}), ...pathsOf(changes.length ? changes : (this.changes.get(id) ?? []), this.cwd) },
          ...(ok ? [{ type: 'files-changed' as const, paths: changes.map((c) => c.path) }] : []),
        ];
      }
      case 'mcpToolCall': {
        const name = mcpName(item);
        const { text, images } = mcpResult(item.result);
        const error = isObj(item.error) ? str(item.error.message) : '';
        const failed = item.status !== 'completed' || Boolean(error) || (isObj(item.result) && item.result.isError === true);
        return [
          ...images.map((image, i) => ({ type: 'image' as const, id: `${id}-${i}`, ...image })),
          { type: 'tool', id, name, summary: summarizeTool(name, isObj(item.arguments) ? item.arguments : {}, this.cwd, this.element), status: failed ? 'failed' : 'finished', detail: clip(error || text, RESULT_LIMIT) },
        ];
      }
      case 'dynamicToolCall':
        return [{ type: 'tool', id, name: str(item.tool) || 'Tool', summary: str(item.tool) || 'A tool', status: item.success === false ? 'failed' : 'finished' }];
      case 'webSearch':
        return [{ type: 'tool', id, name: 'WebSearch', summary: clip(`Search the web${str(item.query) ? ` for ${str(item.query)}` : ''}`, STATUS_LIMIT), status: 'finished' }];
      case 'imageView':
        return [{ type: 'tool', id, name: 'Read', summary: `Look at ${shortPath(str(item.path), this.cwd)}`, status: 'finished' }];
      case 'collabAgentToolCall':
        return [{ type: 'tool', id, name: 'Agent', summary: clip(str(item.prompt) || 'Sub-agent', STATUS_LIMIT), status: item.status === 'failed' ? 'failed' : 'finished' }];
      default:
        return [];
    }
  }
}

/** How a finished turn (`turn/completed`'s turn) ends for Kestrel. */
export function turnEnd(turn: unknown, stopping: boolean, lastError: string | null): AgentEvent {
  const t = isObj(turn) ? turn : {};
  if (t.status === 'completed') return { type: 'done', reason: 'complete' };
  if (t.status === 'interrupted') return stopping ? { type: 'done', reason: 'stopped' } : { type: 'failed', reason: lastError ?? 'Codex stopped the turn before it finished.', kind: 'other' };
  const error = isObj(t.error) ? t.error : {};
  const reason = str(error.message) || lastError || 'Codex could not finish the turn.';
  const auth = error.codexErrorInfo === 'unauthorized' || /not (signed|logged) in|unauthori[sz]ed|codex login/i.test(reason);
  return { type: 'failed', reason: auth ? `${reason} Run \`codex login\` in a terminal, then send again.` : reason, kind: auth ? 'auth' : 'other' };
}
