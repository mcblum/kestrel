// The user's always-allowed list (sandbox-allow/) for Codex: the same entries, the same matching
// function, the same card choices as for a Claude child.
//
// - Folders: a read-and-write entry is one of the sandbox's writable roots for every Codex turn
//   (policy.ts `sandboxPolicy`), so commands writing there do not ask. Codex's protocol has no
//   readable roots (codex-cli 0.167.2: `workspaceWrite` takes `writableRoots` only, and reads are
//   not restricted in workspace-write), so a read-only entry needs nothing; a request for more
//   access is let through when every path it asks to read or write is covered.
// - Commands: in Auto, a command Codex asks about is one leaving its sandbox. One the list covers
//   (judged on the script inside Codex's shell wrapper) is accepted without a card. Manual and
//   Accept edits ask about every command by design, and still do, as a Claude session's commands
//   inside its sandbox still follow the mode.
import type { InputRequest, SandboxAllowAccess, StartOptions } from '../types.ts';
import { unwrapShell } from '../../sandbox-allow/command-line.ts';
import { boundsFolders, commandInBounds, type Bounds } from '../../sandbox-allow/match.ts';
import { offerOptions } from '../../sandbox-allow/offer.ts';
import type { SandboxAllowEntry, SandboxOffer } from '../../shared/sandbox-allow.ts';
import { sandboxBounds } from '../claude/sandbox.ts';
import type { CodexPolicy } from './policy.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);

export const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
export const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval';

/** The read-and-write folders on the list: Codex's extra writable roots. */
export function writableRoots(entries: readonly SandboxAllowEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'folder' && e.access === 'read-write' ? [e.path] : []));
}

/** Where a command's path arguments may point, for the session and a request's own folder. */
function boundsFor(opts: Pick<StartOptions, 'directory' | 'permission' | 'sandboxAllow'>, params: Obj): Bounds {
  const base = sandboxBounds({ ...opts, confineShell: true });
  return typeof params.cwd === 'string' && params.cwd ? { ...base, cwd: params.cwd } : base;
}

/** The script a command request runs, as the list judges it. */
const scriptOf = (params: Obj): string => (typeof params.command === 'string' ? unwrapShell(params.command) : '');

/** A command request the list covers: in bounds by the same rule as a Claude child's. */
function commandCovered(params: Obj, entries: readonly SandboxAllowEntry[], bounds: Bounds): boolean {
  if (params.kind !== undefined && params.kind !== null && params.kind !== 'command') return false;
  const script = scriptOf(params);
  return script !== '' && bounds.folders.some((f) => bounds.cwd === f || bounds.cwd.startsWith(`${f}/`)) && commandInBounds(script, entries, bounds).allowed;
}

/** A request for more access the list covers: no network, and every path asked for inside a listed folder. */
function permissionsCovered(params: Obj, entries: readonly SandboxAllowEntry[]): boolean {
  const asked = isObj(params.permissions) ? params.permissions : {};
  if (isObj(asked.network) && asked.network.enabled === true) return false;
  const fs = isObj(asked.fileSystem) ? asked.fileSystem : {};
  if (Array.isArray(fs.entries) && fs.entries.length > 0) return false; // a shape Kestrel does not read: ask
  const writes = strings(fs.write);
  const reads = strings(fs.read);
  if (writes.length + reads.length === 0) return false;
  const within = (path: string, folders: readonly string[]) => folders.some((f) => path === f || path.startsWith(`${f}/`));
  const anyFolder = entries.flatMap((e) => (e.kind === 'folder' ? [e.path] : []));
  return writes.every((p) => within(p, boundsFolders([], entries))) && reads.every((p) => within(p, anyFolder));
}

/**
 * What to answer at once because the list covers the request, or null to go on as before. Only in
 * Auto (`on-request`), where a card means leaving the sandbox.
 */
export function listAnswer(method: string, params: Obj, policy: CodexPolicy, opts: Pick<StartOptions, 'directory' | 'permission' | 'sandboxAllow'>): unknown | null {
  const entries = opts.sandboxAllow?.entries() ?? [];
  if (policy.approvalPolicy !== 'on-request' || entries.length === 0) return null;
  if (method === COMMAND_APPROVAL) return commandCovered(params, entries, boundsFor(opts, params)) ? { decision: 'accept' } : null;
  if (method !== PERMISSIONS_APPROVAL || !permissionsCovered(params, entries)) return null;
  const asked = isObj(params.permissions) ? params.permissions : {};
  return { permissions: isObj(asked.fileSystem) ? { fileSystem: asked.fileSystem } : {}, scope: 'turn' };
}

/** The offer for a card: from the command's script, or the one folder a request for more access asks to write. */
async function offerFor(method: string, params: Obj, access: SandboxAllowAccess, bounds: Bounds): Promise<SandboxOffer> {
  if (method === COMMAND_APPROVAL) return scriptOf(params) ? access.offer(scriptOf(params), bounds) : {};
  const asked = isObj(params.permissions) ? params.permissions : {};
  const writes = strings(isObj(asked.fileSystem) ? asked.fileSystem.write : undefined);
  if (writes.length !== 1) return {};
  // The folder offer reads paths from a command line; a request names its folder directly.
  const offer = await access.offer(`ls ${JSON.stringify(writes[0])}`, bounds);
  return offer.folder ? { folder: offer.folder } : {};
}

/**
 * The card with the list's two choices added (before "Deny"), when the request has something to
 * offer. Only in Auto: that is where the list answers Codex's requests, so the choice keeps its promise.
 */
export async function withListChoices(request: InputRequest, method: string, params: Obj, policy: CodexPolicy, opts: Pick<StartOptions, 'directory' | 'permission' | 'sandboxAllow'>): Promise<InputRequest> {
  if (!opts.sandboxAllow || policy.approvalPolicy !== 'on-request' || (method !== COMMAND_APPROVAL && method !== PERMISSIONS_APPROVAL)) return request;
  const offer = await offerFor(method, params, opts.sandboxAllow, boundsFor(opts, params)).catch((): SandboxOffer => ({}));
  const always = offerOptions(offer);
  if (always.length === 0) return request;
  const deny = request.options.filter((o) => o.role === 'deny');
  return { ...request, options: [...request.options.filter((o) => o.role !== 'deny'), ...always, ...deny], sandboxOffer: offer };
}
