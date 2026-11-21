// What may go on the always-allowed list, and the reason when something may not. A command entry
// is a program and up to two subcommand words, never a pattern. A folder entry is a real folder,
// absolute with symlinks resolved, that does not make the sandbox meaningless or cross Kestrel's
// other rules: not `/`, not the home folder or a folder holding it, not a registered project's
// folder, not a session's worktree, not Kestrel's own data folder (nor a folder inside or holding
// any of those).
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveReal } from '../agents/claude/confine.ts';
import { Refused } from '../refused.ts';
import type { FolderAccess, SandboxAllowEntry } from '../shared/sandbox-allow.ts';
import { PROGRAM_WORD } from './match.ts';
import { isWrapper } from './wrappers.ts';

/** A program and at most this many words after it. */
const MAX_SUBCOMMAND_WORDS = 2;
/** A subcommand word: plain, and never an option. */
const SUBCOMMAND_WORD = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

/**
 * Programs whose whole job is to run another program or code they are handed: allowing one would
 * allow anything. Refused as entries outright.
 */
const RUNS_ANYTHING = new Set(['sudo', 'doas', 'su', 'env', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'eval', 'exec', 'command', 'builtin', 'xargs', 'nohup', 'nice', 'time', 'timeout', 'watch', 'cd', 'source', 'osascript', 'python', 'python3', 'node', 'perl', 'ruby', 'awk', 'find', 'open', 'script', 'expect',
  // Launchers and wrappers: each runs the command or package it is handed.
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'deno', 'bun', 'php', 'lua', 'tclsh', 'caffeinate', 'arch', 'sandbox-exec', 'stdbuf', 'unbuffer', 'chronic', 'flock', 'setsid', 'ionice', 'taskset', 'direnv', 'nix-shell', 'gtimeout', 'parallel', 'run-parts', 'strace', 'dtruss', 'proxychains', 'proxychains4', 'torsocks']);
/** Programs that need their subcommand named: on their own they can run any program (`git -c core.sshCommand=…`, aliases). */
const NEEDS_SUBCOMMAND = new Set(['git']);

/** What a folder entry is checked against: every path absolute with symlinks resolved. */
export interface FolderContext {
  home: string;
  dataDir: string;
  projectFolders: readonly string[];
  worktrees: readonly string[];
}

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
/** One folder holds the other, or they are the same. */
const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

/** Why a wrapper cannot be an entry, and what to add instead. */
function wrapperRefusal(program: string): string {
  return `"${program}" runs the command after it, so an entry naming it would allow anything outside the sandbox. Add the command it wraps instead, such as "git commit" for "${program} git commit -m …": a command run through ${program} is judged as the command inside it.`;
}

/** A command entry from its words, or a refusal saying why not. */
export function commandEntry(words: readonly string[]): SandboxAllowEntry {
  const [program, ...rest] = words;
  if (!program) throw new Refused('Enter a command, such as "git commit" or "gpg".');
  if (!PROGRAM_WORD.test(program)) throw new Refused(`"${program}" is not a program name. Give the program by its name alone (no path, no variables), then any subcommand words.`);
  if (rest.length > MAX_SUBCOMMAND_WORDS) throw new Refused(`A command entry is a program and at most ${MAX_SUBCOMMAND_WORDS} subcommand words, such as "git commit".`);
  const bad = rest.find((w) => !SUBCOMMAND_WORD.test(w));
  if (bad !== undefined) throw new Refused(`"${bad}" is not a subcommand word. An entry names a program and its subcommand, not options, paths or patterns.`);
  if (isWrapper(program)) throw new Refused(wrapperRefusal(program));
  if (RUNS_ANYTHING.has(program)) throw new Refused(`"${program}" runs other programs or code it is given, so allowing it would allow anything outside the sandbox.`);
  if (NEEDS_SUBCOMMAND.has(program) && rest.length === 0) throw new Refused(`Name the ${program} subcommand, such as "${program} commit": ${program} on its own can run any program through its options and aliases.`);
  return { kind: 'command', words: [program, ...rest] };
}

/**
 * Why a stored entry no longer applies, or null when it does. The rules have grown since some entries
 * were stored (a wrapper such as "rtk git" was accepted before 2026-11-19): an entry that would be
 * refused now is kept on the list, shown as not applied with this reason, and never honoured.
 */
export function staleReason(entry: SandboxAllowEntry): string | null {
  if (entry.kind !== 'command') return null;
  try {
    commandEntry(entry.words);
    return null;
  } catch (error) {
    if (error instanceof Refused) return error.message;
    throw error;
  }
}

/** A command entry from what the user typed: words split at spaces. */
export function commandEntryFromText(text: string): SandboxAllowEntry {
  return commandEntry(text.trim().split(/\s+/).filter(Boolean));
}

/** `~` and `~/…` made absolute; anything else as given. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

function folderRefusal(real: string, c: FolderContext): string | null {
  if (real === '/') return 'The whole disk cannot be allowed: the sandbox would mean nothing.';
  if (within(c.home, real)) return `${real} is your home folder or holds it: the sandbox would mean nothing. Allow the folder a program needs, such as ~/.gnupg.`;
  if (overlaps(real, c.dataDir)) return `${real} overlaps Kestrel's own data folder (${c.dataDir}), which holds every session's worktree and Kestrel's records.`;
  const project = c.projectFolders.find((f) => overlaps(real, f));
  if (project) return `${real} overlaps the registered project folder ${project}. Another project's files are changed by a session of that project (delegate), not by a command.`;
  const worktree = c.worktrees.find((w) => overlaps(real, w));
  if (worktree) return `${real} overlaps the session worktree ${worktree}. A worktree is changed only by the session it was made for.`;
  return null;
}

/** A folder entry, resolved and checked, or a refusal saying why not. */
export function folderEntry(path: string, access: unknown, c: FolderContext): SandboxAllowEntry {
  if (access !== 'read' && access !== 'read-write') throw new Refused('Choose whether commands may only read the folder or also write in it.');
  const given = expandHome(path.trim(), c.home);
  if (!given) throw new Refused('Enter a folder, such as ~/.gnupg.');
  if (!isAbsolute(given)) throw new Refused(`${path} is not a full path. Start it with / or ~/.`);
  if (!existsSync(given) || !statSync(given).isDirectory()) throw new Refused(`There is no folder at ${given}.`);
  const real = resolveReal(given, given);
  const refusal = folderRefusal(real, c);
  if (refusal) throw new Refused(refusal);
  return { kind: 'folder', path: real, access: access as FolderAccess };
}
