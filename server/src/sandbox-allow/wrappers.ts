// Pass-through wrappers: programs that run the command they are given and nothing else, put in
// front of a command by something other than the agent (a user's Claude Code hook rewrites
// `git status` to `rtk git status`, Matt's machine, 2026-11-19). A wrapper runs its arguments as a
// command, so it is never an entry of its own (validate.ts refuses one, as it refuses `sudo`). A
// wrapper on this list is instead seen through: matching and offering judge the command inside it by
// the normal rule, so `rtk git commit -m x` is judged as `git commit -m x`.
//
// The list is deliberately small and a constant, not a setting: declaring a program transparent
// decides what the always-allowed list covers, so it is a reviewed code change. To add a wrapper,
// add an entry below with
//   - `raw`: subcommand words after which the rest is the command, run as given (`rtk proxy <cmd>`);
//   - `own`: the wrapper's own subcommands, which are not a wrapped command (`rtk gain`). Anything
//     starting with `-` is also the wrapper's own (an option), and is not seen through.
// Every other `<wrapper> <command…>` is seen through to `<command…>`.

export interface TransparentWrapper {
  readonly raw: readonly string[];
  readonly own: readonly string[];
}

/** Known transparent proxies, by program name. */
export const TRANSPARENT_WRAPPERS: Readonly<Record<string, TransparentWrapper>> = {
  // Rust Token Killer (rtk): `rtk <command…>` runs the command with its output shortened; `rtk proxy <command…>` runs it raw.
  rtk: { raw: ['proxy'], own: ['gain', 'discover', 'init', 'config', 'help', 'version', 'proxy'] },
};

/** Wrappers inside wrappers are seen through this many times at most; deeper nesting is judged as written (and asks). */
const MAX_NESTING = 4;

export const isWrapper = (program: string | undefined): boolean => program !== undefined && Object.hasOwn(TRANSPARENT_WRAPPERS, program);

/** The words inside one layer of wrapper, or null when `words` is not a wrapped command. */
function unwrapOnce(words: readonly string[]): string[] | null {
  const [program, next] = words;
  if (!isWrapper(program) || next === undefined) return null;
  const wrapper = TRANSPARENT_WRAPPERS[program!]!;
  if (wrapper.raw.includes(next)) return words.length > 2 ? words.slice(2) : null;
  if (next.startsWith('-') || wrapper.own.includes(next)) return null;
  return words.slice(1);
}

/** A simple command's words with every known wrapper around it removed (`rtk proxy rtk git x` → `git x`). */
export function unwrapCommand(words: readonly string[]): string[] {
  let current = [...words];
  for (let depth = 0; depth < MAX_NESTING; depth += 1) {
    const inner = unwrapOnce(current);
    if (!inner) return current;
    current = inner;
  }
  return current;
}
