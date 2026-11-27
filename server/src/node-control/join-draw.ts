// How `kestrel node join` looks in the terminal: the node says what happens as typed events (shared/node-commands.ts,
// `NodeJoinEvent`), and this lays them out, one event at a time, as lines. Nothing here decides what is said.
//
//   Kestrel worker node: join <name> to your account
//
//   1  Sign in
//      Open   <address>
//      Code   ABCD-EFGH   (works for 10 minutes)
//
//      Waiting for you to sign in…
//      ✓ Signed in as <email>
//
//   2  Let this node in            (and 3  Confirm)
//   …
//
//   ✓ <name> is in your account and connected to Kestrel Connect.
//
//   Next: kestrel node status
//
// Steps are set apart by a blank line, a code stands on a line of its own, a step done is a tick, and a problem is a
// whole sentence set off by blank lines. Where the output is not a terminal (piped, NO_COLOR, TERM=dumb) the same
// lines in the same order are plain ASCII ("ok:" for the tick), so a log or a script reads them.
import type { JoinStep, NodeJoinEvent } from '../shared/node-commands.ts';

export interface JoinStyle {
  /** ASCII only: no ticks, ellipses or arrows. */
  plain: boolean;
  /** Where text is wrapped; a word longer than that stands on its own line. */
  width: number;
}

const MIN_WIDTH = 40;
const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 80;

/** The style for this output: plain unless it is a terminal that is not dumb and colour is not refused. */
export function joinStyleOf(output: { isTTY: boolean; columns?: number }, env: Record<string, string | undefined>): JoinStyle {
  const plain = !output.isTTY || env.NO_COLOR !== undefined || env.TERM === 'dumb';
  const columns = output.columns && output.columns > 0 ? output.columns : DEFAULT_WIDTH;
  return { plain, width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, columns - 1)) };
}

/** Where the drawing is: whether anything was printed, and whether the last line was blank. */
export interface JoinDrawState {
  printed: boolean;
  blank: boolean;
}

export const JOIN_DRAW_START: JoinDrawState = { printed: false, blank: false };

/** What one event draws: lines for the output (or, for a join that did not finish, the error output), and a prompt. */
export interface JoinDrawn {
  lines: string[];
  toErr: boolean;
  /** For an `ask`: the prompt to print before the answer is typed, on the line after `lines`. */
  prompt: string | null;
  state: JoinDrawState;
}

const STEP_INDENT = '   ';
const CODE_INDENT = '    ';
const FIELD_LABEL_WIDTH = 7;

const TYPOGRAPHY: readonly [RegExp, string][] = [
  [/…/g, '...'],
  [/[→⟶]/g, '->'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/ /g, ' '],
];

const asciiOf = (text: string): string => TYPOGRAPHY.reduce((t, [from, to]) => t.replace(from, to), text);

const tick = (style: JoinStyle): string => (style.plain ? 'ok: ' : '✓ ');

const indentOf = (step: JoinStep): string => (step === 0 ? '' : STEP_INDENT);

/** A six-digit code in two groups of three; anything else as it is. */
export const groupedCode = (code: string): string => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** `text` broken at spaces to fit `width`, every line starting with `indent`. */
export function wrapped(text: string, indent: string, width: number): string[] {
  const room = Math.max(1, width - indent.length);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter(Boolean)) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, indent + line];
}

/** The lines one event draws after `state`, in `style`. Pure. */
export function drawJoinEvent(event: NodeJoinEvent, state: JoinDrawState, style: JoinStyle): JoinDrawn {
  const out: string[] = [];
  let { printed, blank } = state;
  const put = (...lines: string[]) => {
    for (const line of lines) {
      out.push(style.plain ? asciiOf(line) : line);
      printed = true;
      blank = line === '';
    }
  };
  // Text that is wrapped is made ASCII first, so the width holds for what is printed.
  const wrap = (text: string, indent: string) => wrapped(style.plain ? asciiOf(text) : text, indent, style.width);
  // A blank line, unless at the very start or after one.
  const gap = () => printed && !blank && put('');
  const done = (toErr = false, prompt: string | null = null): JoinDrawn => ({ lines: out, toErr, prompt: prompt && style.plain ? asciiOf(prompt) : prompt, state: { printed, blank } });

  if (event.event === 'ask') return done(false, `${indentOf(event.step)}${event.prompt}`);
  if (event.event === 'end') {
    gap();
    if (event.ok) put(`${tick(style)}${event.text}`);
    else put(...wrap(event.text, ''));
    if (event.next) {
      put('');
      put(`Next: ${event.next}`);
    }
    return done(!event.ok);
  }
  const indent = indentOf(event.step);
  switch (event.kind) {
    case 'heading':
      gap();
      put(event.step === 0 ? event.text : `${event.step}  ${event.text}`);
      if (event.step === 0) put('');
      break;
    case 'line':
      put(...wrap(event.text, indent));
      break;
    case 'wait':
      gap();
      put(...wrap(event.text, indent));
      break;
    case 'field':
      put(`${indent}${event.label.padEnd(FIELD_LABEL_WIDTH)}${event.value}${event.note ? `   (${event.note})` : ''}`);
      break;
    case 'code':
      gap();
      put(`${indent}${CODE_INDENT}${groupedCode(event.code)}`, '');
      break;
    case 'done':
      put(`${indent}${tick(style)}${event.text}`);
      break;
    case 'problem':
      gap();
      put(...wrap(event.text, indent), '');
      break;
    case 'quote':
      put(`${indent}${CODE_INDENT}${event.text}`);
      break;
  }
  return done();
}

/** A whole conversation drawn, each `ask` followed by the answer typed (as a terminal echoes it). For tests and logs. */
export function drawJoin(events: readonly NodeJoinEvent[], style: JoinStyle, answers: readonly string[] = []): string[] {
  const lines: string[] = [];
  let state = JOIN_DRAW_START;
  let answered = 0;
  for (const event of events) {
    const drawn = drawJoinEvent(event, state, style);
    lines.push(...drawn.lines);
    state = drawn.state;
    if (drawn.prompt !== null) {
      lines.push(`${drawn.prompt}${answers[answered++] ?? ''}`);
      state = { printed: true, blank: false };
    }
  }
  return lines;
}
