// What each Kestrel permission level means for OpenCode. Pure.
//
// OpenCode has no sandbox: a command it runs can reach anything the user can (opencode 1.14.25).
// What it has is a permission system that can ask about every tool call before it runs, and a
// check that asks again (`external_directory`) when a call names a path outside the session's
// folder, commands included (it reads the command line for paths; a path built at run time, in a
// script or a variable, is not seen). Kestrel has it ask about everything that changes something
// (config.ts) and answers each ask itself (decide.ts), so:
//   Manual (ask)     every edit, command and other tool that changes something is a card.
//   Accept edits     edits inside the folder are accepted; edits outside it, every command and
//                    every other such tool are cards.
//   Auto             edits, commands and other tools run without asking, outside the folder too.
//                    In a session another session started, a command or edit that OpenCode sees
//                    reaching outside the folder is a card, unless the user's always-allowed list
//                    covers the command.
//   Bypass           everything runs without asking. The edit rule still applies.
//   Plan             OpenCode's own `plan` agent, with the edit tools taken away; commands are
//                    cards. The finished answer is the plan: a "Plan ready" card moves the
//                    session on, as for Codex.
//   Read only        the edit tools and the shell are taken away; reads outside the registered
//                    projects are refused.
// Kestrel's edit rule (shared/project-edits.ts) runs on every edit OpenCode asks about, before any
// of this. A session another session started (`confineShell`) is held to its folder by path: in
// every level but Bypass (which a child never has), an edit or command that OpenCode sees reaching
// outside its folder is a card.
import type { PermissionLevel } from '../../shared/permissions.ts';
import { READ_ONLY_OMITTED } from '../../kestrel-mcp.ts';
import { KESTREL_SERVER, opencodeToolName } from './config.ts';

/** Every level the adapter maps: the mode menu offers these for OpenCode. */
export const OPENCODE_LEVELS: readonly PermissionLevel[] = ['auto', 'ask', 'edits', 'plan', 'bypass', 'readonly'];

export interface OpencodePolicy {
  /** OpenCode's agent for the turn. */
  agent: 'build' | 'plan';
  /** Nothing may be written or run. */
  readOnly: boolean;
  plan: boolean;
  /** Edits accepted without a card once the edit rule passed them: inside the folder, anywhere, or none. */
  acceptEdits: 'none' | 'folder' | 'anywhere';
  /** Commands run without a card (in the folder, for Auto). */
  acceptCommands: boolean;
  /** Reaching outside the folder needs no card. */
  acceptOutside: boolean;
  /** Tools that change something other than files (a user's MCP server, a web fetch) run without a card. */
  acceptOther: boolean;
}

export function opencodePolicy(level: PermissionLevel): OpencodePolicy {
  const base: OpencodePolicy = { agent: 'build', readOnly: false, plan: false, acceptEdits: 'none', acceptCommands: false, acceptOutside: false, acceptOther: false };
  switch (level) {
    case 'ask':
      return base;
    case 'edits':
      return { ...base, acceptEdits: 'folder' };
    case 'auto':
      return { ...base, acceptEdits: 'anywhere', acceptCommands: true, acceptOther: true };
    case 'bypass':
      return { ...base, acceptEdits: 'anywhere', acceptCommands: true, acceptOutside: true, acceptOther: true };
    case 'plan':
      return { ...base, agent: 'plan', plan: true };
    case 'readonly':
      return { ...base, readOnly: true };
  }
}

/** The session's own rules, on top of the process's (config.ts): what a level takes away from the model altogether. */
export function sessionRules(level: PermissionLevel): { permission: string; pattern: string; action: 'deny' }[] {
  const deny = (permission: string) => ({ permission, pattern: '*', action: 'deny' as const });
  if (level === 'readonly') return [deny('edit'), deny('bash'), ...READ_ONLY_OMITTED.map((t) => deny(opencodeToolName(KESTREL_SERVER, t)))];
  if (level === 'plan') return [deny('edit')];
  return [];
}
