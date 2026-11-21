// What each Kestrel permission level means for Codex: its approval policy, who reviews approvals,
// its sandbox, plan mode, and what Kestrel itself answers without asking. Pure.
//
// Codex sandboxes by folder: `workspace-write` lets commands and edits write inside the working
// folder (plus the system temp folders) and blocks everything else; a blocked write then goes
// through the approval policy. Approvals always come to Kestrel (reviewer `user`): Codex's own
// reviewer (`auto_review`) decides without Kestrel ever seeing the request, so Kestrel's edit rule
// (shared/project-edits.ts: no edits into another project or another session's worktree) could not
// refuse anything it approved (found live, 2026-11-18). The edit rule runs on every file change
// Codex asks about, before anything below. So "where a session may write follows its level" is:
//   Manual (ask)        untrusted + workspace-write: every command Codex does not know to be safe,
//                       and every file change, inside the folder or out, is a card.
//   Accept edits        the same, but Kestrel accepts file changes inside the working folder;
//                       a change outside it and every command are still cards.
//   Auto                on-request + workspace-write: commands and edits inside the sandbox run
//                       without asking. A file change Codex asks about (one outside it) is let
//                       through; a command or a request for more access that leaves the sandbox is
//                       a card, unless the user's always-allowed list covers it (allow-list.ts).
//                       Its read-and-write folders are writable roots. A file change inside the sandbox is never asked about, so the edit
//                       rule cannot stop it: Kestrel checks it once applied and says so (handle.ts).
//   Bypass              untrusted + danger-full-access: Codex asks about every file change and every
//                       command it does not know to be safe, and Kestrel accepts each at once. Asking
//                       is what lets the edit rule see every file change; nothing is sandboxed.
//   Plan                never + read-only + Codex's plan collaboration mode: reads and plans;
//                       the finished plan is a "Plan ready" card that moves the session on.
//   Read only           never + read-only: reads anything, writes nothing, nothing to ask.
// Network is on in workspace-write (`sandbox_workspace_write.network_access`), as for Claude.
import type { PermissionLevel } from '../../shared/permissions.ts';

/** Every level `codexPolicy` maps: the mode menu offers these for Codex. */
export const CODEX_LEVELS: readonly PermissionLevel[] = ['auto', 'ask', 'edits', 'plan', 'bypass', 'readonly'];

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type Reviewer = 'user' | 'auto_review';

export interface CodexPolicy {
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: Reviewer;
  sandbox: SandboxMode;
  /** Codex's plan collaboration mode for the turn. */
  plan: boolean;
  /** Nothing may be written; Kestrel's acting tools are not offered at all. */
  readOnly: boolean;
  /** File changes Kestrel accepts without a card, once its edit rule has passed them: inside the working folder (Accept edits), anywhere (Auto, Bypass), or none. */
  acceptEdits: 'none' | 'folder' | 'anywhere';
  /** Kestrel accepts every command and request for more access without a card (Bypass). */
  acceptAll: boolean;
  /** Kestrel's tools that act on something (browser clicks, simulator taps…) are cards. */
  askBeforeKestrelActions: boolean;
}

export function codexPolicy(level: PermissionLevel): CodexPolicy {
  const base = { approvalsReviewer: 'user' as Reviewer, plan: false, readOnly: false, acceptEdits: 'none' as CodexPolicy['acceptEdits'], acceptAll: false, askBeforeKestrelActions: false };
  switch (level) {
    case 'ask':
      return { ...base, approvalPolicy: 'untrusted', sandbox: 'workspace-write', askBeforeKestrelActions: true };
    case 'edits':
      return { ...base, approvalPolicy: 'untrusted', sandbox: 'workspace-write', acceptEdits: 'folder', askBeforeKestrelActions: true };
    case 'auto':
      return { ...base, approvalPolicy: 'on-request', sandbox: 'workspace-write', acceptEdits: 'anywhere' };
    case 'bypass':
      return { ...base, approvalPolicy: 'untrusted', sandbox: 'danger-full-access', acceptEdits: 'anywhere', acceptAll: true };
    case 'plan':
      return { ...base, approvalPolicy: 'never', sandbox: 'read-only', plan: true, askBeforeKestrelActions: true };
    case 'readonly':
      return { ...base, approvalPolicy: 'never', sandbox: 'read-only', readOnly: true };
  }
}

/** The thread and turn parameters a policy sets (`thread/start`, `thread/resume`, `turn/start` take them). */
export function policyParams(policy: CodexPolicy): { approvalPolicy: ApprovalPolicy; approvalsReviewer: Reviewer; sandbox: SandboxMode } {
  return { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandbox: policy.sandbox };
}

/**
 * `turn/start` takes the sandbox as a full policy rather than a mode name. `writableRoots`: folders
 * beyond the working one that commands may write (the read-and-write folders on the user's
 * always-allowed list); the protocol has no readable roots, and workspace-write reads anywhere.
 */
export function sandboxPolicy(mode: SandboxMode, writableRoots: readonly string[] = []): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [...writableRoots], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}
