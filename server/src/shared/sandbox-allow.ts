// The always-allowed list for a child session's shell sandbox (Settings → Workflow; Matt,
// 2026-11-18): commands and folders the user has said are always in bounds. One list for every
// project, because it is about this Mac (gpg's ~/.gnupg, for one). Claude only for now. Only the
// user adds to it: from the sandbox card or in Settings, never through a Kestrel tool.
// Shared with the UI: the shapes, and the words that describe an entry.

/** A folder entry's access: `read` lets commands read it, `read-write` also write in it. */
export type FolderAccess = 'read' | 'read-write';

export type SandboxAllowEntry =
  /** A program and, optionally, its subcommand words, e.g. ["git", "commit"] or ["gpg"]. */
  | { kind: 'command'; words: string[] }
  /** A folder and everything under it, absolute with symlinks resolved. */
  | { kind: 'folder'; path: string; access: FolderAccess };

/** What a card for a command outside the sandbox offers to add; each part only when there is one. */
export interface SandboxOffer {
  command?: string[];
  folder?: { path: string; access: FolderAccess };
}

/** A stored entry that the rules now refuse: kept so the user sees it, never applied. */
export interface InactiveEntry {
  entry: SandboxAllowEntry;
  /** Why it is not applied, and what to add instead. */
  reason: string;
}

export interface SandboxAllowView {
  /** The entries in effect. */
  entries: SandboxAllowEntry[];
  /**
   * Sessions started by another session may run commands outside their sandbox without asking, when the session that
   * started them could (shared/sandbox-inherit.ts; issue 74). Off by default; absent from an older server.
   */
  inherit?: boolean;
  /** Entries stored before a rule changed that would be refused now: shown, not applied. */
  inactive?: InactiveEntry[];
}

/** The option ids on the sandbox card that add to the list (and allow the pending request). */
export const ALWAYS_COMMAND = 'always-command';
export const ALWAYS_FOLDER = 'always-folder';

export const ACCESS_WORDS: Record<FolderAccess, string> = { read: 'read only', 'read-write': 'read and write' };

/** The one key an entry is known by: removing it and noticing a duplicate both use it. */
export function entryId(entry: SandboxAllowEntry): string {
  return entry.kind === 'command' ? `command:${entry.words.join(' ')}` : `folder:${entry.path}`;
}

/** An entry in words, as Settings and the card's buttons show it. */
export function describeEntry(entry: SandboxAllowEntry): string {
  return entry.kind === 'command' ? entry.words.join(' ') : `${entry.path} (${ACCESS_WORDS[entry.access]})`;
}

/** The card's button labels: they say exactly what would be added. */
export function offerLabel(kind: 'command' | 'folder', offer: SandboxOffer): string | null {
  if (kind === 'command') return offer.command ? `Always allow this command: ${offer.command.join(' ')}` : null;
  return offer.folder ? `Always allow this folder: ${describeEntry({ kind: 'folder', ...offer.folder })}` : null;
}
