// Requests Codex sends Kestrel (JSON-RPC requests from the server) -> what to do with each:
// answer at once, ask the user with a card (the same card shapes Claude's approvals use), or
// refuse. Pure: the caller sends the answer and shows the card.
//
// Kestrel's own tools never ask, except the ones that act on something (browser clicks, simulator
// taps…), which follow the level as they do for Claude. Everything else follows the level
// (policy.ts).
import { relative, isAbsolute, resolve } from 'node:path';
import { clip, describeApproval, shortPath, type ElementLookup } from '../claude/describe.ts';
import { BROWSER_ACTIONS, SIM_ACTIONS } from '../claude/options.ts';
import type { InputAnswer, InputOption, InputRequest } from '../types.ts';
import type { FileChange } from './map.ts';
import type { CodexPolicy } from './policy.ts';
import type { RpcError } from './rpc.ts';
import { KESTREL_SERVER } from './config.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MAX_DETAIL = 4000;

/** What to send back for a card, given the user's answer. `steer` is said to the agent on the running turn (a decline carries no message of its own). */
export interface CardReply {
  result: unknown;
  steer?: string;
}

export type Handling =
  | { kind: 'answer'; result: unknown }
  | { kind: 'card'; request: InputRequest; reply: (answer: InputAnswer) => CardReply; /** What a stop or a dropped card answers. */ cancel: unknown }
  | { kind: 'refuse'; error: RpcError };

export interface ApprovalContext {
  policy: CodexPolicy;
  directory: string;
  /** The file changes of a `fileChange` item seen earlier in the turn. */
  changes(itemId: string): readonly FileChange[] | undefined;
  element?: ElementLookup;
}

const ALLOW: InputOption[] = [
  { id: 'allow', label: 'Allow', role: 'allow' },
  { id: 'deny', label: 'Deny', role: 'deny' },
];
const ASKING_KESTREL_TOOLS = new Set([...BROWSER_ACTIONS, ...SIM_ACTIONS]);
const declined = (answer: InputAnswer) => answer.optionId !== 'allow';
const steerFor = (answer: InputAnswer) => (answer.text?.trim() ? `The user declined that action: ${answer.text.trim()}` : undefined);

export function inside(path: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(directory, path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A level that may change nothing (Plan, Read only): Codex should not ask, and is refused if it does. */
const changesNothing = (policy: CodexPolicy) => policy.readOnly || policy.plan;

function command(id: string, params: Obj, ctx: ApprovalContext): Handling {
  const accept = { decision: 'accept' };
  const decline = { decision: 'decline' };
  if (changesNothing(ctx.policy)) return { kind: 'answer', result: decline };
  if (ctx.policy.acceptAll) return { kind: 'answer', result: accept };
  // Manual and Accept edits: any command Codex asks about. Auto: one that leaves the sandbox.
  const actions = Array.isArray(params.commandActions) ? params.commandActions.filter(isObj) : [];
  const shown = actions.length === 1 && str(actions[0]!.command) ? str(actions[0]!.command) : str(params.command);
  const { title, detail } = describeApproval('Bash', { command: shown, description: str(params.reason) }, ctx.directory);
  return {
    kind: 'card',
    request: { id, kind: 'approval', tool: 'Bash', title, detail, options: ALLOW },
    reply: (answer) => (declined(answer) ? { result: decline, steer: steerFor(answer) } : { result: accept }),
    cancel: decline,
  };
}

function changesDetail(changes: readonly FileChange[], directory: string): string {
  return clip(changes.map((c) => (changes.length === 1 ? c.diff : `${c.kind === 'add' ? 'Write' : c.kind === 'delete' ? 'Delete' : 'Edit'} ${shortPath(c.path, directory)}\n${c.diff}`)).join('\n\n'), MAX_DETAIL);
}

function fileChange(id: string, params: Obj, ctx: ApprovalContext): Handling {
  const accept = { decision: 'accept' };
  const decline = { decision: 'decline' };
  // Kestrel's edit rule has already run (handle.ts): what reaches here follows the level.
  if (changesNothing(ctx.policy)) return { kind: 'answer', result: decline };
  if (ctx.policy.acceptEdits === 'anywhere') return { kind: 'answer', result: accept };
  const changes = ctx.changes(str(params.itemId)) ?? [];
  const inFolder = changes.length > 0 && changes.every((c) => inside(c.path, ctx.directory));
  if (ctx.policy.acceptEdits === 'folder' && inFolder) return { kind: 'answer', result: accept };
  const only = changes.length === 1 ? changes[0]! : null;
  const tool = only?.kind === 'add' ? 'Write' : 'Edit';
  const where = only ? shortPath(only.path, ctx.directory) : `${changes.length} files`;
  const title = only?.kind === 'add' ? `Write ${where}` : only?.kind === 'delete' ? `Delete ${where}` : `Edit ${where}`;
  const why = [str(params.reason), str(params.grantRoot) ? `Codex also asks to write anywhere under ${str(params.grantRoot)} for the rest of the session.` : ''].filter(Boolean).join('\n');
  const detail = [why, changes.length ? changesDetail(changes, ctx.directory) : 'Codex did not say which files.'].filter(Boolean).join('\n\n');
  return {
    kind: 'card',
    request: { id, kind: 'approval', tool, title: changes.length ? title : 'Change files', detail, options: ALLOW },
    reply: (answer) => (declined(answer) ? { result: decline, steer: steerFor(answer) } : { result: accept }),
    cancel: decline,
  };
}

function elicitation(id: string, params: Obj, ctx: ApprovalContext): Handling {
  const accept = { action: 'accept', content: {}, _meta: null };
  const decline = { action: 'decline', content: null, _meta: null };
  const meta = isObj(params._meta) ? params._meta : {};
  const server = str(params.serverName);
  if (meta.codex_approval_kind === 'mcp_tool_call') {
    const name = `mcp__${server}__${str(meta.tool_name)}`;
    const input = isObj(meta.tool_params) ? meta.tool_params : {};
    if (server === KESTREL_SERVER) {
      if (!ASKING_KESTREL_TOOLS.has(name) || !ctx.policy.askBeforeKestrelActions) return { kind: 'answer', result: ctx.policy.readOnly && ASKING_KESTREL_TOOLS.has(name) ? decline : accept };
    } else if (ctx.policy.readOnly) return { kind: 'answer', result: decline };
    else if (ctx.policy.acceptAll || (ctx.policy.approvalPolicy !== 'untrusted' && !ctx.policy.plan)) return { kind: 'answer', result: accept };
    const { title, detail } = describeApproval(name, input, ctx.directory, ctx.element);
    return { kind: 'card', request: { id, kind: 'approval', tool: name, title, detail, options: ALLOW }, reply: (answer) => (declined(answer) ? { result: decline, steer: steerFor(answer) } : { result: accept }), cancel: decline };
  }
  // A server asking the user something. A plain yes/no (no fields) is a card; a form with fields is not supported yet.
  const schema = isObj(params.requestedSchema) ? params.requestedSchema : {};
  const fields = isObj(schema.properties) ? Object.keys(schema.properties) : [];
  if (params.mode !== 'form' || fields.length > 0) return { kind: 'answer', result: decline };
  return {
    kind: 'card',
    request: { id, kind: 'approval', tool: `mcp__${server}`, title: `${server} asks`, detail: clip(str(params.message), MAX_DETAIL), options: ALLOW },
    reply: (answer) => ({ result: declined(answer) ? decline : accept }),
    cancel: decline,
  };
}

function permissions(id: string, params: Obj, ctx: ApprovalContext): Handling {
  const asked = isObj(params.permissions) ? params.permissions : {};
  const grant = { permissions: { ...(isObj(asked.network) ? { network: asked.network } : {}), ...(isObj(asked.fileSystem) ? { fileSystem: asked.fileSystem } : {}) }, scope: 'turn' };
  const refuse = { permissions: {}, scope: 'turn' };
  if (changesNothing(ctx.policy)) return { kind: 'answer', result: refuse };
  if (ctx.policy.acceptAll) return { kind: 'answer', result: grant };
  // Manual, Accept edits, and Auto (more access is leaving the sandbox): a card.
  const fs = isObj(asked.fileSystem) ? asked.fileSystem : {};
  const writes = Array.isArray(fs.write) ? fs.write.filter((p): p is string => typeof p === 'string') : [];
  const network = isObj(asked.network) && asked.network.enabled === true;
  const detail = [str(params.reason), writes.length ? `Write to:\n${writes.map((p) => `- ${p}`).join('\n')}` : '', network ? 'Use the network.' : ''].filter(Boolean).join('\n\n');
  return {
    kind: 'card',
    request: { id, kind: 'approval', tool: 'Permissions', title: 'Allow more access for this turn', detail: detail || 'Codex asks for more access than this session has.', options: ALLOW },
    reply: (answer) => (declined(answer) ? { result: refuse, steer: steerFor(answer) } : { result: grant }),
    cancel: refuse,
  };
}

interface Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
}

function userInput(id: string, params: Obj): Handling {
  const questions: Question[] = (Array.isArray(params.questions) ? params.questions : []).filter(isObj).map((q) => ({
    id: str(q.id),
    header: str(q.header),
    question: str(q.question),
    options: (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o) => ({ label: str(o.label), description: str(o.description) || undefined })),
  }));
  const only = questions.length === 1 ? questions[0]! : null;
  const empty = { answers: {} };
  return {
    kind: 'card',
    request: {
      id,
      kind: 'question',
      tool: 'AskUserQuestion',
      title: 'Codex is asking you',
      detail: questions[0]?.question ?? '',
      questions: questions.map((q) => ({ question: q.question, header: q.header || undefined, multi: false, options: q.options })),
      options: (only?.options ?? []).map((o, i) => ({ id: String(i), label: o.label, role: 'choice' as const })),
    },
    reply: (answer) => {
      const picked = only ? (only.options[Number(answer.optionId)]?.label ?? answer.text ?? '') : '';
      const answers = Object.fromEntries(questions.map((q) => [q.id, { answers: [answer.answers?.[q.question] ?? (q === only ? picked : '')].filter(Boolean) }]));
      return { result: { answers } };
    },
    cancel: empty,
  };
}

/** What to do with one request from Codex. `id` is the card id (unique per session). */
/** Codex asking whether a file change may be applied. */
export const FILE_CHANGE_APPROVAL = 'item/fileChange/requestApproval';

export function handleRequest(method: string, params: Obj, id: string, ctx: ApprovalContext): Handling {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return command(id, params, ctx);
    case FILE_CHANGE_APPROVAL:
      return fileChange(id, params, ctx);
    case 'mcpServer/elicitation/request':
      return elicitation(id, params, ctx);
    case 'item/permissions/requestApproval':
      return permissions(id, params, ctx);
    case 'item/tool/requestUserInput':
      return userInput(id, params);
    default:
      // Legacy approvals (v1), client-side tools, token refresh and attestation are not something Kestrel offers.
      return { kind: 'refuse', error: { code: -32601, message: `Kestrel does not handle ${method}.` } };
  }
}
