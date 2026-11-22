// Holding a session's shell commands to its own folder. File edits are checked by path
// (confine.ts); a command cannot be, so Claude Code's own OS sandbox does it. Tried live on SDK
// 0.3.325 (2026-11-18): a write outside the allowed folders fails with "operation not permitted",
// the approval callback is still asked for every command, and a command Claude runs again with
// `dangerouslyDisableSandbox` reaches the callback with that flag set.
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { commandInBounds, type Bounds } from '../../sandbox-allow/match.ts';
import type { SandboxAllowEntry, SandboxOffer } from '../../shared/sandbox-allow.ts';
import { claudePermission } from '../../shared/permissions.ts';
import { worktreeRepo } from '../../worktree-repo.ts';
import type { StartOptions } from '../types.ts';

export const UNSANDBOXED_NOTE = "Runs outside the sandbox: it can change files outside this session's folder";

type Confined = Pick<StartOptions, 'directory' | 'permission' | 'confineShell' | 'sandboxAllow' | 'commitSigning' | 'sandboxSupport'>;

/** The temporary folders, which the sandbox's own rules let commands write. Windows has no /tmp. */
const TEMP_FOLDERS = [...new Set([...(process.platform === 'win32' ? [] : ['/tmp', '/private/tmp']), tmpdir(), realpathSync(tmpdir())])];

/** The folders the user put on the always-allowed list, by access (Settings → Workflow). */
function allowedFolders(entries: readonly SandboxAllowEntry[]): { read: string[]; write: string[] } {
  const folders = entries.flatMap((e) => (e.kind === 'folder' ? [e] : []));
  return { read: folders.map((f) => f.path), write: folders.filter((f) => f.access === 'read-write').map((f) => f.path) };
}

/** The folders a session's own commands write in: its folder and, for a worktree, its repository's `.git`. */
function ownFolders(directory: string, repoOf: (worktree: string) => string | null): string[] {
  const repo = repoOf(directory);
  return [directory, ...(repo ? [join(repo, '.git')] : [])];
}

/**
 * The sandbox a session's commands run in, or nothing when it has none: only a session Kestrel
 * marked (`confineShell`), that runs commands at all, and whose user did not choose Bypass.
 *
 * Commands may write in the session's folder and, for a worktree, in its repository's `.git`
 * (a commit in a worktree writes there). Temporary folders are writable by the sandbox's own
 * rules. The network is left open, as it is for a Codex session: this is about files.
 * Folders on the user's always-allowed list are added: read-and-write ones to what commands may
 * write, all of them to what they may read. Built each time a run starts, so a change to the list
 * reaches a running session from its next message. When the repository signs its commits, signing
 * gets through (`commitSigning`): GnuPG's home is readable and the signing agent's socket can be
 * reached; nothing more, and nothing of it writable.
 *
 * Nothing, too, on a computer that has no sandbox (`sandboxSupport`): asking the SDK for one there
 * ends the run with an error. Such a session is held by `unconfinedReason` instead.
 */
export function shellSandbox(opts: Confined, repoOf: (worktree: string) => string | null = worktreeRepo): Options['sandbox'] | undefined {
  if (!wantsConfinedShell(opts) || opts.sandboxSupport?.available === false) return undefined;
  const listed = allowedFolders(opts.sandboxAllow?.entries() ?? []);
  const read = [...listed.read, ...(opts.commitSigning?.read ?? [])];
  const sockets = opts.commitSigning?.sockets ?? [];
  return {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    filesystem: { allowWrite: [...ownFolders(opts.directory, repoOf), ...listed.write], ...(read.length ? { allowRead: read } : {}) },
    network: { allowedDomains: ['*'], ...(sockets.length ? { allowUnixSockets: sockets } : {}) },
  };
}

/** A session Kestrel marked (`confineShell`), that runs commands at all, and whose user did not choose Bypass. */
function wantsConfinedShell(opts: Confined): boolean {
  if (!opts.confineShell) return false;
  const { permissionMode, readOnly } = claudePermission(opts.permission);
  return !readOnly && permissionMode !== 'bypassPermissions';
}

/** The tools that run a shell command: Bash everywhere, and PowerShell on Windows. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * Why a session that should be sandboxed is not, or null when it is (or needs none). Such a
 * session's every command asks, in every mode: with nothing to hold a command to the session's
 * folder, the user is the check. "Allow all" on that card and the always-allowed list still apply.
 */
export function unconfinedReason(opts: Confined): string | null {
  return wantsConfinedShell(opts) && opts.sandboxSupport?.available === false ? opts.sandboxSupport.reason : null;
}

/** Whether a tool call is a command of a session that has no sandbox to run it in. */
export function isUnconfinedCommand(tool: string, input: Record<string, unknown>, opts: Confined): boolean {
  return SHELL_TOOLS.has(tool) && typeof input.command === 'string' && unconfinedReason(opts) !== null;
}

/** The note on that command's card, and the hook's reason. */
export const unconfinedNote = (reason: string): string => `Not sandboxed (${reason}): it can change files outside this session's folder`;

/** Where a command's path arguments may point for it to be covered by a command entry (sandbox-allow/match.ts). */
export function sandboxBounds(opts: Confined, repoOf: (worktree: string) => string | null = worktreeRepo, home: string = homedir()): Bounds {
  const listed = allowedFolders(opts.sandboxAllow?.entries() ?? []);
  return { cwd: opts.directory, home, folders: [...ownFolders(opts.directory, repoOf), ...TEMP_FOLDERS, ...listed.write] };
}

/** Whether a tool call is a command Claude asked to run outside the sandbox. */
export function isUnsandboxed(tool: string, input: Record<string, unknown>): boolean {
  return tool === 'Bash' && input.dangerouslyDisableSandbox === true;
}

/** The hook's reason when a command outside the sandbox runs because the user listed it. */
export const ON_LIST_NOTE = 'On the always-allowed list (Settings → Workflow).';

/** Whether a command Claude asked to run outside the sandbox is covered by the user's list. */
export function onAllowList(input: Record<string, unknown>, opts: Confined, repoOf: (worktree: string) => string | null = worktreeRepo): boolean {
  const entries = opts.sandboxAllow?.entries() ?? [];
  if (typeof input.command !== 'string' || entries.length === 0) return false;
  return commandInBounds(input.command, entries, sandboxBounds(opts, repoOf)).allowed;
}

/** Whether the card for a call may offer to put something on the list: a confined session's command outside the sandbox. */
export function offersAllowList(tool: string, input: Record<string, unknown>, opts: Confined, repoOf: (worktree: string) => string | null = worktreeRepo): boolean {
  return !!opts.sandboxAllow && typeof input.command === 'string' && isUnsandboxed(tool, input) && !!shellSandbox(opts, repoOf);
}

/** What that card offers; nothing when it may offer nothing or the offer cannot be worked out. */
export async function cardOffer(tool: string, input: Record<string, unknown>, opts: Confined, repoOf: (worktree: string) => string | null = worktreeRepo): Promise<SandboxOffer> {
  if (!opts.sandboxAllow || !offersAllowList(tool, input, opts, repoOf)) return {};
  return opts.sandboxAllow.offer(String(input.command), sandboxBounds(opts, repoOf)).catch(() => ({}));
}

/**
 * The card's detail when a hook on this computer rewrote the command Claude wrote (`git commit` →
 * `rtk git commit`): what Claude asked for, which the conversation's step line shows, then what will
 * really run, which is what the list judged and what an "Always allow" choice is worked out from.
 * Null when nothing rewrote it.
 */
export function rewrittenDetail(input: Record<string, unknown>, written: string | undefined): string | null {
  const runs = typeof input.command === 'string' ? input.command : '';
  if (written === undefined || written === runs) return null;
  const why = typeof input.description === 'string' && input.description ? `${input.description}\n\n` : '';
  return `${why}Claude asked to run:\n${written}\n\nA hook on this computer changed it. What will run:\n${runs}`;
}
