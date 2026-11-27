// Whether a session another session started may run commands outside its sandbox without asking (Matt,
// 2026-11-27, issue 74: "If the user wants, we should be able to just always allow the child session / workstream
// delegate to inherit the permissions of the parent"). One switch, beside the always-allowed list, off by default.
//
// A session the user started in Auto (or Bypass) is not asked what it takes outside its sandbox or folder: Codex's and
// OpenCode's asks are accepted at once, and Claude runs it (Matt, 2026-11-23). A session another session started
// (handoff, delegate, spawn; a guest too) is confined: such a command asks. With the switch on, a child in Auto whose
// starter would not be asked is not asked either, and so on down: a child of a child inherits while every session
// above it does. A child of a Manual session still asks, as Manual does. It never makes a child Bypass
// (`childPermission` is unchanged), and it is only about the sandbox ask for commands: a child's file edits by path
// stay in its own worktree, and one writer per worktree still holds (shared/project-edits.ts, worktree-guests.ts).
// Only the user turns it on: in Settings, or with the sandbox card's choice after a confirmation. Shared with the UI.
import type { PermissionLevel } from './permissions.ts';

/** The modes in which a session the user started takes what it asks outside its sandbox without a card. */
const UNASKED: readonly PermissionLevel[] = ['auto', 'bypass'];

/**
 * Whether a session's commands that leave its sandbox run without asking. `chain`: the session's own mode first, then
 * the mode of the session that started it, and so on up to the session the user started (one entry for that one).
 * `inherit`: the switch. Empty: nothing is known of it, so it asks.
 */
export function leavesSandboxUnasked(chain: readonly PermissionLevel[], inherit: boolean): boolean {
  const [own, ...above] = chain;
  if (own === undefined || !UNASKED.includes(own)) return false;
  if (above.length === 0) return true;
  return inherit && leavesSandboxUnasked(above, inherit);
}

/** Whether a session another session started (a chain of two or more) is let out of its sandbox's ask by the switch. */
export const inheritsOutside = (chain: readonly PermissionLevel[], inherit: boolean): boolean => chain.length > 1 && leavesSandboxUnasked(chain, inherit);

/**
 * Whether the sandbox card of such a session offers to turn the switch on: it is off, and turning it on would let this
 * session's commands through (its starter would not be asked), so the choice keeps its promise.
 */
export const offersInherit = (chain: readonly PermissionLevel[], inherit: boolean): boolean => !inherit && inheritsOutside(chain, true);

/** The card's choice that turns the switch on (after the confirmation) and allows this command. */
export const ALWAYS_CHILDREN = 'always-children';
export const ALWAYS_CHILDREN_LABEL = 'Always allow for sessions started by another session';

/** The switch, as Settings words it. */
export const INHERIT_LABEL = 'Sessions started by another session may run commands outside their sandbox without asking, when the session that started them could';

/** What the card's choice asks before it turns the switch on. */
export const INHERIT_CONFIRM =
  'Turn on "' +
  INHERIT_LABEL +
  '"?\n\nFrom now on, a session started by another session (handoff, delegate or spawn) that is in Auto runs the commands it asks to take outside its sandbox without asking you, whenever the session that started it would not be asked either. A child of a Manual session still asks. Its file edits stay in its own worktree. You can turn this off in Settings → Permissions.';

/**
 * Why the card's choice was refused: the answer did not say the person confirmed it. The window asks; a device that
 * cannot ask (a phone app that does not know the choice yet) is refused, and the switch stays off.
 */
export const INHERIT_UNCONFIRMED = 'Turning this on for every session started by another session needs your confirmation, which this device did not ask for. Answer the card on your computer, or turn it on in Settings → Permissions.';

/** Why a command outside the sandbox ran without a card (the Claude hook's reason). */
export const INHERITED_NOTE = 'Sessions started by another session may run commands outside their sandbox (Settings → Permissions).';
