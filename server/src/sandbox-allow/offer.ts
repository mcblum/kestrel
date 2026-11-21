// What the card for a command outside the sandbox offers to put on the always-allowed list, and
// what choosing it does. The offer is worked out by Kestrel from the command and kept on the card
// the server holds; choosing it adds exactly that entry (checked again) and allows the request.
// The answer the UI sends names only the option, so nothing an agent wrote can choose what is added.
import { dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { InputAnswer, InputOption } from '../agents/types.ts';
import { Refused } from '../refused.ts';
import { ALWAYS_COMMAND, ALWAYS_FOLDER, offerLabel, type SandboxAllowEntry, type SandboxOffer } from '../shared/sandbox-allow.ts';
import { lexCommandLine } from './command-line.ts';
import { commandInBounds, outsidePaths, type Bounds } from './match.ts';
import { commandEntry, folderEntry, type FolderContext } from './validate.ts';
import { unwrapCommand } from './wrappers.ts';

/** A word that reads as a subcommand (`commit`, `sign-off`), not a file or an option. */
const SUBCOMMAND_LIKE = /^[a-z][a-z0-9-]*$/i;

/**
 * The command entry to offer: the program and its subcommand, when that entry would cover this very
 * line. A wrapped command (`rtk git commit -m x`) offers the command inside it (`git commit`).
 */
export function commandOffer(line: string, bounds: Bounds): string[] | undefined {
  const lexed = lexCommandLine(line);
  if (!lexed.ok || lexed.commands.length !== 1) return undefined;
  const [program, next] = unwrapCommand(lexed.commands[0]!);
  const words = next !== undefined && SUBCOMMAND_LIKE.test(next) ? [program!, next] : [program!];
  try {
    const entry = commandEntry(words);
    return commandInBounds(line, [entry], bounds).allowed ? words : undefined;
  } catch {
    return undefined; // not something the list may hold: no offer
  }
}

/** The folder to offer: the one folder outside the bounds that the command names, read and write. */
export function folderOffer(line: string, bounds: Bounds, context: FolderContext): SandboxOffer['folder'] {
  const folders = [...new Set(outsidePaths(line, bounds).map((p) => (existsSync(p) && statSync(p).isDirectory() ? p : dirname(p))))];
  if (folders.length !== 1) return undefined;
  try {
    const entry = folderEntry(folders[0]!, 'read-write', context);
    return entry.kind === 'folder' ? { path: entry.path, access: entry.access } : undefined;
  } catch {
    return undefined;
  }
}

/** Both offers for a line; an empty object when there is nothing to offer. */
export function sandboxOffer(line: string, bounds: Bounds, context: FolderContext): SandboxOffer {
  const command = commandOffer(line, bounds);
  const folder = folderOffer(line, bounds, context);
  return { ...(command ? { command } : {}), ...(folder ? { folder } : {}) };
}

/** The card's extra choices for an offer, each labelled with exactly what it adds. */
export function offerOptions(offer: SandboxOffer): InputOption[] {
  const command = offerLabel('command', offer);
  const folder = offerLabel('folder', offer);
  return [...(command ? [{ id: ALWAYS_COMMAND, label: command, role: 'allow' as const }] : []), ...(folder ? [{ id: ALWAYS_FOLDER, label: folder, role: 'allow' as const }] : [])];
}

/** The entry an "Always allow" choice adds, from the card's own offer; null for any other choice. */
export function chosenEntry(offer: SandboxOffer | undefined, optionId: string | undefined, context: FolderContext): SandboxAllowEntry | null {
  if (optionId !== ALWAYS_COMMAND && optionId !== ALWAYS_FOLDER) return null;
  if (optionId === ALWAYS_COMMAND) {
    if (!offer?.command) throw new Refused('This card does not offer to always allow a command.');
    return commandEntry(offer.command);
  }
  if (!offer?.folder) throw new Refused('This card does not offer to always allow a folder.');
  return folderEntry(offer.folder.path, offer.folder.access, context);
}

/** What the agent is answered once the entry is added: the request is allowed. */
export const allowAnswer = (answer: InputAnswer): InputAnswer => ({ ...answer, optionId: 'allow' });
