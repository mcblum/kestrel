// Whether a command line Claude asked to run outside the sandbox is covered by the user's
// always-allowed list, so it runs without a card. Pure. The rule, conservatively:
//
// 1. The line must be readable (command-line.ts): plain words, quotes, `;` `&&` `||` `|` and
//    harmless redirections only. Anything the shell would expand or reinterpret asks.
// 2. EVERY simple command in it must match a command entry. A chain or pipe is in bounds only
//    when each part is.
// 3. A command matches an entry when its program word is exactly the entry's program (a bare name:
//    `/usr/bin/git`, `./git` and `VAR=x git` never match) and the entry's subcommand words follow
//    it immediately and exactly. So `git -c core.sshCommand=… commit` does not match `git commit`:
//    nothing may come between the program and its subcommand.
// 4. Every argument that names a path (it, or an option's `=value`, or a short option's glued
//    value, starts with `/` or `~`, or has a `..` segment) must lie in a folder in bounds: the
//    session's own folder, its repository's `.git`, the temporary folders, or a read-and-write
//    folder entry. `git commit --template=/etc/passwd` asks.
// 5. A known pass-through wrapper in front of a simple command (`rtk git commit`, wrappers.ts) is
//    seen through first: the command inside it is what rules 3 and 4 judge.
import { posix } from 'node:path';
import type { SandboxAllowEntry } from '../shared/sandbox-allow.ts';
import { lexCommandLine } from './command-line.ts';
import { unwrapCommand } from './wrappers.ts';

export interface Bounds {
  /** Where relative paths in the command are read from: the session's folder. */
  cwd: string;
  /** The user's home folder, for `~`. */
  home: string;
  /** Absolute folders a path argument may name. */
  folders: readonly string[];
}

export type CommandVerdict = { allowed: true } | { allowed: false; reason: string };

/** A program word an entry can name: a bare name, no path, no assignment. */
export const PROGRAM_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

/** The value an argument carries: itself, an option's `=value`, or a short option's glued value (`-F../x`). */
function valueOf(word: string): string | null {
  if (!word.startsWith('-')) return word;
  if (word.includes('=')) return word.slice(word.indexOf('=') + 1);
  return word.startsWith('--') ? null : word.slice(2);
}

/** The path a word names, when it names one. */
function pathIn(word: string): string | null {
  const value = valueOf(word);
  if (value === null) return null;
  if (value.startsWith('/') || value.startsWith('~')) return value;
  return value.split('/').includes('..') ? value : null;
}

/** Whether a path argument stays in bounds. */
function pathInBounds(path: string, b: Bounds): boolean {
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/')) return false;
  const expanded = path.startsWith('~') ? b.home + path.slice(1) : path;
  const absolute = posix.resolve(b.cwd, expanded);
  return b.folders.some((folder) => within(absolute, folder));
}

function matchesEntry(words: readonly string[], entry: Extract<SandboxAllowEntry, { kind: 'command' }>): boolean {
  if (!PROGRAM_WORD.test(words[0] ?? '')) return false;
  return entry.words.length <= words.length && entry.words.every((w, i) => words[i] === w);
}

function simpleCommandVerdict(written: readonly string[], commands: readonly Extract<SandboxAllowEntry, { kind: 'command' }>[], b: Bounds): CommandVerdict {
  const words = unwrapCommand(written);
  const entry = commands.find((e) => matchesEntry(words, e));
  if (!entry) return { allowed: false, reason: `"${words.join(' ')}" is not on the always-allowed list` };
  const outside = words.slice(entry.words.length).map(pathIn).find((p) => p !== null && !pathInBounds(p, b));
  return outside === undefined ? { allowed: true } : { allowed: false, reason: `it names ${outside}, which is outside the folders in bounds` };
}

/** The paths `line`'s arguments name outside the folders in bounds, made absolute; empty when unreadable. */
export function outsidePaths(line: string, b: Bounds): string[] {
  const lexed = lexCommandLine(line);
  if (!lexed.ok) return [];
  const paths = lexed.commands.flatMap((words) => unwrapCommand(words).slice(1).map(pathIn)).filter((p): p is string => p !== null && !pathInBounds(p, b));
  return paths.filter((p) => p === '~' || p.startsWith('~/') || !p.startsWith('~')).map((p) => posix.resolve(b.cwd, p.startsWith('~') ? b.home + p.slice(1) : p));
}

/** Whether `line` runs without a card under `entries` (see the rule above). */
export function commandInBounds(line: string, entries: readonly SandboxAllowEntry[], b: Bounds): CommandVerdict {
  const commands = entries.filter((e): e is Extract<SandboxAllowEntry, { kind: 'command' }> => e.kind === 'command');
  if (commands.length === 0) return { allowed: false, reason: 'no command is on the always-allowed list' };
  const lexed = lexCommandLine(line);
  if (!lexed.ok) return { allowed: false, reason: `it has ${lexed.reason}` };
  for (const words of lexed.commands) {
    const verdict = simpleCommandVerdict(words, commands, b);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

/** The folders a path argument may name for a session: its own, any extra (.git, temp), and read-and-write entries. */
export function boundsFolders(own: readonly string[], entries: readonly SandboxAllowEntry[]): string[] {
  return [...own, ...entries.flatMap((e) => (e.kind === 'folder' && e.access === 'read-write' ? [e.path] : []))];
}
