// What Kestrel answers to one OpenCode permission ask (`permission.asked`, opencode 1.14.25): at
// once ("once" or "reject" with a message the agent reads), or by a card the user answers. Pure;
// the edit rule (an async check) has already run on an edit by the time this is asked (handle.ts).
// The levels are described in policy.ts.
import { isAbsolute, resolve } from 'node:path';
import { clip, type ElementLookup } from '../claude/describe.ts';
import { confinementDenial } from '../claude/confine.ts';
import { sandboxBounds } from '../claude/sandbox.ts';
import { commandInBounds } from '../../sandbox-allow/match.ts';
import { offerOptions } from '../../sandbox-allow/offer.ts';
import type { SandboxOffer } from '../../shared/sandbox-allow.ts';
import type { InputAnswer, InputOption, InputRequest, StartOptions } from '../types.ts';
import { ACTING_KESTREL_TOOLS } from './config.ts';
import type { ToolCall } from './map.ts';
import type { OpencodePolicy } from './policy.ts';
import { describeCall, editedPaths } from './tools.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MAX_DETAIL = 4000;

/** A `permission.asked` request, as Kestrel reads it. */
export interface Ask {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Obj;
  callID: string | null;
}

export function readAsk(p: Obj): Ask | null {
  if (!str(p.id) || !str(p.permission)) return null;
  const tool = isObj(p.tool) ? p.tool : {};
  return {
    id: str(p.id),
    sessionID: str(p.sessionID),
    permission: str(p.permission),
    patterns: Array.isArray(p.patterns) ? p.patterns.filter((x): x is string => typeof x === 'string') : [],
    metadata: isObj(p.metadata) ? p.metadata : {},
    callID: str(tool.callID) || null,
  };
}

export type Reply = { reply: 'once' } | { reply: 'reject'; message: string };

export type Decision = { kind: 'reply'; answer: Reply } | { kind: 'card'; request: Omit<InputRequest, 'id'>; reply(answer: InputAnswer): Reply };

export interface DecideContext {
  policy: OpencodePolicy;
  directory: string;
  /** Where OpenCode's relative ask patterns start: the project root it reports. */
  root: string;
  /** A session another session started: held to its folder by path. */
  confined: boolean;
  readable: readonly string[];
  sandboxAllow?: StartOptions['sandboxAllow'];
  element?: ElementLookup;
}

const ALLOW: InputOption[] = [
  { id: 'allow', label: 'Allow', role: 'allow' },
  { id: 'deny', label: 'Deny', role: 'deny' },
];
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'lsp']);
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch']);
const WEB_TOOLS = new Set(['webfetch', 'websearch', 'codesearch']);

export const CHANGES_NOTHING = 'This session is in Plan or Read only, so it does not change files or run commands. Write what you would do instead.';
export const DECLINED = 'The user declined this.';
/** Without a message OpenCode ends the whole turn on a reject; with one the agent reads it and carries on. */
const declineFor = (answer: InputAnswer): Reply => ({ reply: 'reject', message: answer.text?.trim() ? `The user declined this: ${answer.text.trim()}` : DECLINED });
const once: Decision = { kind: 'reply', answer: { reply: 'once' } };
const reject = (message: string): Decision => ({ kind: 'reply', answer: { reply: 'reject', message } });

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

/** The files an edit ask is about, absolute: what OpenCode names, else the call's own input. */
export function askedPaths(ask: Ask, call: ToolCall | undefined, directory: string, root: string): string[] {
  const named = str(ask.metadata.filepath);
  if (named) return [resolve(directory, named)];
  const fromCall = call ? editedPaths(call.tool, call.input, directory) : [];
  if (fromCall.length) return fromCall;
  return ask.patterns.filter((p) => p !== '*').map((p) => (isAbsolute(p) ? p : resolve(root, p)));
}

/** The folders an `external_directory` ask names (its patterns are `folder/*`). */
const askedFolders = (ask: Ask): string[] => ask.patterns.map((p) => p.replace(/\/\*$/, '')).filter((p) => p && p !== '*');

function card(ask: Ask, call: ToolCall | undefined, ctx: DecideContext, fallback: { title: string; detail: string }, extra: Partial<InputRequest> = {}): Decision {
  const shown = call ? describeCall(call.tool, call.input, ctx.directory, ctx.element) : fallback;
  const diff = str(ask.metadata.diff);
  const detail = clip([shown.detail, diff && !shown.detail.includes(diff) ? diff : ''].filter(Boolean).join('\n\n') || fallback.detail, MAX_DETAIL);
  return {
    kind: 'card',
    request: { kind: 'approval', tool: call ? call.tool : ask.permission, title: shown.title || fallback.title, detail, options: ALLOW, ...extra },
    reply: (answer) => (answer.optionId === 'allow' || answer.optionId?.startsWith('always-') ? { reply: 'once' } : declineFor(answer)),
  };
}

function edit(ask: Ask, call: ToolCall | undefined, ctx: DecideContext): Decision {
  if (ctx.policy.readOnly || ctx.policy.plan) return reject(CHANGES_NOTHING);
  const paths = askedPaths(ask, call, ctx.directory, ctx.root);
  const outside = paths.length === 0 || paths.some((p) => !within(p, ctx.directory));
  const fallback = { title: paths.length === 1 ? `Edit ${paths[0]}` : 'Change files', detail: paths.join('\n') };
  if (ctx.confined && outside && !ctx.policy.acceptOutside) return card(ask, call, ctx, fallback);
  if (ctx.policy.acceptEdits === 'anywhere' || (ctx.policy.acceptEdits === 'folder' && !outside)) return once;
  return card(ask, call, ctx, fallback);
}

function command(ask: Ask, call: ToolCall | undefined, ctx: DecideContext): Decision {
  if (ctx.policy.readOnly) return reject(CHANGES_NOTHING);
  if (ctx.policy.acceptCommands) return once;
  return card(ask, call, ctx, { title: 'Run a command', detail: ask.patterns.join('\n') });
}

/** A command reaching outside the folder that the always-allowed list covers. */
function listed(command: string, ctx: DecideContext): boolean {
  const entries = ctx.sandboxAllow?.entries() ?? [];
  if (!command || entries.length === 0) return false;
  return commandInBounds(command, entries, sandboxBounds({ directory: ctx.directory, permission: 'auto', confineShell: true, sandboxAllow: ctx.sandboxAllow })).allowed;
}

function outsideFolder(ask: Ask, call: ToolCall | undefined, ctx: DecideContext, offer: SandboxOffer | null): Decision {
  const tool = call?.tool ?? '';
  const folders = askedFolders(ask);
  if (READ_TOOLS.has(tool) || (!tool && str(ask.metadata.filepath))) {
    if (!ctx.policy.readOnly) return once;
    const denial = [...folders, str(ask.metadata.filepath)].filter(Boolean).map((f) => confinementDenial('Read', { file_path: f }, { directory: ctx.directory, readOnly: true, readable: ctx.readable })).find(Boolean);
    return denial ? reject(denial) : once;
  }
  if (ctx.policy.readOnly) return reject(CHANGES_NOTHING);
  // The edit ask that follows decides an edit, with the file's full path.
  if (EDIT_TOOLS.has(tool)) return once;
  const fallback = { title: 'Reach outside the session folder', detail: `OpenCode asks to work in:\n${folders.map((f) => `- ${f}`).join('\n')}` };
  if (ctx.policy.acceptOutside) return once;
  if (tool === 'bash') {
    if (listed(str(call?.input.command), ctx)) return once;
    const always = offer ? offerOptions(offer) : [];
    const shown = card(ask, call, ctx, fallback, always.length ? { options: [ALLOW[0]!, ...always, ALLOW[1]!], sandboxOffer: offer! } : {});
    return shown.kind === 'card' ? { ...shown, request: { ...shown.request, title: `Run outside the session folder: ${shown.request.title}` } } : shown;
  }
  if (ctx.policy.acceptOther && !ctx.confined) return once;
  return card(ask, call, ctx, fallback);
}

function other(ask: Ask, call: ToolCall | undefined, ctx: DecideContext): Decision {
  const web = WEB_TOOLS.has(ask.permission);
  const acting = ACTING_KESTREL_TOOLS.includes(ask.permission);
  if (ctx.policy.readOnly) return web ? once : reject(CHANGES_NOTHING);
  if (ctx.policy.acceptOther || (web && ctx.policy.acceptOutside)) return once;
  const fallback = acting ? { title: ask.permission, detail: '' } : { title: `Use ${ask.permission}`, detail: ask.patterns.filter((p) => p !== '*').join('\n') || `OpenCode asks to use ${ask.permission}.` };
  return card(ask, call, ctx, fallback);
}

/**
 * The answer to one ask. `offer`: what the card for a command reaching outside the folder may
 * offer to put on the always-allowed list (asked by the caller, which can await it).
 */
export function decide(ask: Ask, call: ToolCall | undefined, ctx: DecideContext, offer: SandboxOffer | null = null): Decision {
  switch (ask.permission) {
    case 'edit':
      return edit(ask, call, ctx);
    case 'bash':
      return command(ask, call, ctx);
    case 'external_directory':
      return outsideFolder(ask, call, ctx, offer);
    case 'doom_loop':
      return ctx.policy.acceptOutside ? once : card(ask, call, ctx, { title: 'OpenCode repeated the same call', detail: 'It made the same tool call three times in a row. Allow it to go on?' });
    default:
      return other(ask, call, ctx);
  }
}
