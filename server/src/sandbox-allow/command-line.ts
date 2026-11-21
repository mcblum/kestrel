// A deliberately small reading of a shell command line, for deciding whether a command entry on
// the always-allowed list covers it. It understands only plain words, single and double quotes,
// the chaining operators `;`, `&&`, `||`, `|` and newlines, and a few harmless redirections
// (`2>&1`, `>&2`, `>/dev/null`). Anything else a shell would expand or interpret (variables, `$(…)`,
// backticks, globs, braces, backslashes, other redirections, subshells, background `&`, comments,
// history `!`) makes the line unreadable, and an unreadable line is never in bounds: it asks.

export type Lexed = { ok: true; commands: string[][] } | { ok: false; reason: string };

/** Characters that, unquoted, mean the shell would do more than pass a word through. */
const UNQUOTED_REFUSED = new Set(['$', '`', '(', ')', '<', '{', '}', '*', '?', '[', ']', '!', '\\']);
/** Characters that, inside double quotes, still expand. */
const DOUBLE_QUOTED_REFUSED = new Set(['$', '`', '\\', '!']);
/** The only places output may be sent: another of the command's own streams, or nowhere. */
const REDIRECT_TARGETS = ['&1', '&2', '/dev/null'];
const BLANK = new Set([' ', '\t']);
const SEPARATORS = ['&&', '||', ';', '\n', '|'];

const refuse = (reason: string): Lexed => ({ ok: false, reason });

interface State {
  readonly commands: string[][];
  words: string[];
  word: string;
  /** A word has started, even an empty quoted one (`''`). */
  started: boolean;
  /** The last separator could end the line (`;` or a newline), so an empty command after it is fine. */
  trailingOk: boolean;
}

function endWord(s: State): void {
  if (!s.started) return;
  s.words = [...s.words, s.word];
  s.word = '';
  s.started = false;
}

function endCommand(s: State, separator: string): string | null {
  endWord(s);
  if (s.words.length === 0) return `an empty command before "${separator}"`;
  s.commands.push(s.words);
  s.words = [];
  s.trailingOk = separator === ';' || separator === '\n';
  return null;
}

/** Reads a quoted run starting at `i` (the quote); returns the index after the closing quote, or -1. */
function readQuoted(line: string, i: number, s: State): number | string {
  const quote = line[i]!;
  const close = line.indexOf(quote, i + 1);
  if (close === -1) return 'an unclosed quote';
  const inside = line.slice(i + 1, close);
  if (quote === '"' && [...inside].some((c) => DOUBLE_QUOTED_REFUSED.has(c))) return 'something the shell would expand inside double quotes';
  s.word += inside;
  s.started = true;
  return close + 1;
}

/** Reads a redirection whose `>` is at `i`; returns the index after its target, or a reason. */
function readRedirect(line: string, i: number, s: State): number | string {
  // The descriptor before `>` is part of the redirection: `2>&1`. Any other word glued to it is not.
  if (s.started && !/^[12&]$/.test(s.word)) return 'a redirection glued to a word';
  s.word = '';
  s.started = false;
  let j = i + 1;
  if (line[j] === '>') j += 1;
  while (BLANK.has(line[j] ?? '')) j += 1;
  const target = REDIRECT_TARGETS.find((t) => line.startsWith(t, j) && /^[\s;|&]?$/.test(line[j + t.length] ?? ''));
  if (!target) return 'a redirection to a file';
  return j + target.length;
}

/** The separator starting at `i`, if any. A lone `&` (background) and `|&` are not separators. */
function separatorAt(line: string, i: number): string | null {
  if (line.startsWith('|&', i)) return null;
  return SEPARATORS.find((sep) => line.startsWith(sep, i)) ?? null;
}

/** One step of the reader at `i`: the next index, or a reason the line cannot be read. */
function step(line: string, i: number, s: State): number | string {
  const c = line[i]!;
  if (c === "'" || c === '"') return readQuoted(line, i, s);
  if (c === '>') return readRedirect(line, i, s);
  if (c === '&' && line[i + 1] === '>') {
    if (s.started) return 'a redirection glued to a word';
    return readRedirect(line, i + 1, s);
  }
  const sep = separatorAt(line, i);
  if (sep) return endCommand(s, sep) ?? i + sep.length;
  if (c === '&') return 'a command sent to the background (&)';
  if (BLANK.has(c)) {
    endWord(s);
    return i + 1;
  }
  if (UNQUOTED_REFUSED.has(c)) return `"${c}", which the shell would interpret`;
  if (c === '#' && !s.started) return 'a comment';
  s.word += c;
  s.started = true;
  return i + 1;
}

/** The shells Codex wraps every command in (`/bin/zsh -lc '<script>'`), by path or name. */
const WRAPPING_SHELLS = /^(\/bin\/|\/usr\/bin\/|\/opt\/homebrew\/bin\/|\/usr\/local\/bin\/)?(zsh|bash|sh)$/;
const SCRIPT_FLAGS = new Set(['-c', '-lc']);

/**
 * The script inside Codex's own shell wrapper, so it is judged by the same rule as anything else;
 * the line as given when it is not exactly that wrapper. Only `<shell> -c|-lc <one word>` unwraps.
 */
export function unwrapShell(line: string): string {
  const lexed = lexCommandLine(line);
  if (!lexed.ok || lexed.commands.length !== 1) return line;
  const [shell, flag, script, ...rest] = lexed.commands[0]!;
  return WRAPPING_SHELLS.test(shell ?? '') && SCRIPT_FLAGS.has(flag ?? '') && script !== undefined && rest.length === 0 ? script : line;
}

/** The simple commands of `line`, each as its words with quotes removed, or why it cannot be read. */
export function lexCommandLine(line: string): Lexed {
  const s: State = { commands: [], words: [], word: '', started: false, trailingOk: false };
  let i = 0;
  while (i < line.length) {
    const next = step(line, i, s);
    if (typeof next === 'string') return refuse(next);
    i = next;
  }
  endWord(s);
  if (s.words.length > 0) s.commands.push(s.words);
  else if (s.commands.length === 0) return refuse('an empty command');
  else if (!s.trailingOk) return refuse('a command line that ends in an operator');
  return { ok: true, commands: s.commands };
}
