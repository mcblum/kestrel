// The modes a session can run in, named as Claude Desktop names them, and what each means for
// the agent SDK. Shared by the UI (labels) and the adapters (mapping). `bypass` skips every
// prompt: the UI asks the user to confirm it each time it is chosen, for that session only, so a
// new session never starts in it (see `stickyPermission`).
import type { Agent } from '../model.ts';

export type PermissionLevel = 'auto' | 'ask' | 'edits' | 'plan' | 'readonly' | 'bypass';

export interface PermissionMode {
  id: PermissionLevel;
  label: string;
  hint: string;
  /**
   * Where it appears in the Mode menu. `listed` modes are the numbered rows; `bypass` is the row
   * with its own Enable button; `hidden` is kept for sessions that already have it and is not
   * offered for new choices.
   */
  place: 'listed' | 'bypass' | 'hidden';
  /** What the mode does for an agent where `hint` would be wrong for it (Codex: agents/codex/policy.ts; OpenCode: agents/opencode/policy.ts). */
  byAgent?: Partial<Record<Agent, string>>;
}

export const PERMISSION_LEVELS: readonly PermissionMode[] = [
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Claude handles permission decisions',
    place: 'listed',
    // Since 0.0.16 every Codex approval comes to Kestrel (policy.ts): Codex's reviewer decides nothing.
    // OpenCode has no sandbox: Kestrel answers its asks (agents/opencode/policy.ts).
    byAgent: {
      codex: 'Works in its sandbox without asking; asks to leave it unless always-allowed',
      opencode: 'Edits and runs commands without asking (no sandbox); asks before a command reaches outside its folder unless always-allowed',
    },
  },
  { id: 'ask', label: 'Manual', hint: 'Always ask before making changes', place: 'listed' },
  {
    id: 'edits',
    label: 'Accept edits',
    hint: 'Automatically accept all file edits',
    place: 'listed',
    byAgent: {
      codex: 'Accepts file edits in its folder; asks before commands and edits outside it',
      opencode: 'Accepts file edits in its folder; asks before commands and edits outside it',
    },
  },
  { id: 'plan', label: 'Plan', hint: 'Create a plan before making changes', place: 'listed' },
  { id: 'bypass', label: 'Bypass permissions', hint: 'Edits files and runs any command without asking', place: 'bypass' },
  { id: 'readonly', label: 'Read only', hint: 'Can read, cannot edit or run commands', place: 'hidden' },
];

/** What a mode does for the agent a session runs on: its own wording where it has one, the common hint otherwise. */
export const permissionHint = (mode: Pick<PermissionMode, 'hint' | 'byAgent'>, agent?: Agent): string => (agent && mode.byAgent?.[agent]) || mode.hint;

export const DEFAULT_PERMISSION: PermissionLevel = 'ask';

/** The level that skips every prompt. Choosing it needs the user's confirmation. */
export const SKIP_PROMPTS: PermissionLevel = 'bypass';

export const SKIP_PROMPTS_CONFIRM =
  'Bypass permissions for this session?\n\nThe agent will edit files and run any command without asking you first, anywhere your account can reach.';

export const isPermissionLevel = (value: unknown): value is PermissionLevel => PERMISSION_LEVELS.some((l) => l.id === value);

/** Where a new session starts after the user last chose Bypass: its confirmation is for that one session. */
export const AFTER_SKIP_PROMPTS: PermissionLevel = 'auto';

/**
 * The mode a new session starts in, from the mode the user most recently chose by hand, anywhere
 * (a session's controls, a new-session draft, Settings). Bypass is confirmed per session, so it is
 * not carried over: the next session starts in Auto instead.
 */
export const stickyPermission = (chosen: PermissionLevel): PermissionLevel => (chosen === SKIP_PROMPTS ? AFTER_SKIP_PROMPTS : chosen);

/**
 * The mode a session starts in when another session started it (handoff, delegate, spawn): its
 * parent's, so work the user set going in Auto does not stop at every child's first command
 * (Matt, 2026-11-18). Never Bypass, which the user confirms for one session only: a Bypass
 * parent's child runs in Auto. A read-only parent's child, or one whose parent is unknown,
 * starts in Manual. Whatever the mode, the child's commands stay in its sandbox.
 */
export function childPermission(parent: PermissionLevel | undefined): PermissionLevel {
  if (parent === undefined || parent === 'readonly') return DEFAULT_PERMISSION;
  return stickyPermission(parent);
}

export interface SdkPermission {
  permissionMode: 'auto' | 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
  readOnly: boolean;
}

/**
 * Whether a file edit outside the session's own folder must ask, in a mode that would otherwise
 * let it through. Accept edits passes edits in every working directory the SDK knows, the folders
 * a session may read included, so outside the session's folder it asks. Manual asks for every edit
 * anyway; this keeps it asking even when a settings rule would allow the path. Auto leaves it to
 * its classifier, Bypass runs it, Plan runs no edits, Read only has no edit tools.
 */
export const asksOutsideFolder = (level: PermissionLevel): boolean => level === 'ask' || level === 'edits';

/** Claude Agent SDK permission mode for a level. Only `bypass` produces `bypassPermissions`. */
export function claudePermission(level: PermissionLevel): SdkPermission {
  switch (level) {
    case 'auto':
      // A classifier approves or refuses each call, and asks the user when it cannot decide.
      return { permissionMode: 'auto', readOnly: false };
    case 'ask':
      return { permissionMode: 'default', readOnly: false };
    case 'edits':
      return { permissionMode: 'acceptEdits', readOnly: false };
    case 'plan':
      return { permissionMode: 'plan', readOnly: false };
    case 'readonly':
      return { permissionMode: 'dontAsk', readOnly: true };
    case 'bypass':
      return { permissionMode: 'bypassPermissions', readOnly: false };
  }
}
