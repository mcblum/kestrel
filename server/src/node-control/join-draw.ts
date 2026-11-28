// Shared terminal presentation for configure, pairing, agents and Git. The flows choose the words and actions;
// this renderer lays out one typed event at a time so it can also be used for transcripts.
import { stripVTControlCharacters, styleText } from 'node:util';
import stringWidth from 'string-width';
import type { JoinStep, NodeJoinEvent } from '../shared/node-commands.ts';

export interface JoinStyle {
  /** Disable terminal styling and use plain punctuation in prose. */
  plain: boolean;
  /** Color is only enabled for a live terminal. Transcripts can use Unicode without ANSI. */
  color?: boolean;
  width: number;
}

const MAX_WIDTH = 100;
const DEFAULT_COLUMNS = 80;

export function joinStyleOf(output: { isTTY: boolean; columns?: number }, env: Record<string, string | undefined>): JoinStyle {
  const plain = !output.isTTY || env.NO_COLOR !== undefined || env.TERM === 'dumb';
  const columns = output.columns && output.columns > 0 ? output.columns : DEFAULT_COLUMNS;
  return { plain, width: Math.min(MAX_WIDTH, Math.max(1, columns - 1)) };
}

/** The transcript uses stdout and stderr. Keep both plain if either stream is redirected. */
export function terminalJoinStyle(): JoinStyle {
  const style = joinStyleOf({ isTTY: process.stdout.isTTY === true && process.stderr.isTTY === true, columns: process.stdout.columns }, process.env);
  return { ...style, color: !style.plain };
}

/**
 * What the renderer draws: the node's events, and one more kind the terminal makes itself. A command run inside a
 * section of `kestrel node configure` keeps its own parts as unnumbered subheadings under that section, so the whole
 * run reads as one hierarchy (`nestedEvent`).
 */
export type DrawEvent = NodeJoinEvent | { event: 'say'; step: JoinStep; kind: 'subheading'; text: string };

/**
 * One event of a command run inside configure's section `section`: its title is dropped (the section names it), its
 * numbered parts become subheadings, everything is drawn under the section, and how it ended is a line there (configure
 * says what is next itself). Null: drawn not at all.
 */
export function nestedEvent(event: NodeJoinEvent, section: JoinStep): DrawEvent | null {
  if (event.event === 'end') return { event: 'say', step: section, kind: event.ok ? 'done' : 'line', text: event.text };
  if (event.event === 'ask') return { ...event, step: section };
  if (event.kind === 'heading') return event.step === 0 ? null : { event: 'say', step: section, kind: 'subheading', text: event.text };
  return { ...event, step: section };
}

export interface JoinDrawState {
  printed: boolean;
  blank: boolean;
}

export const JOIN_DRAW_START: JoinDrawState = { printed: false, blank: false };

export interface JoinDrawn {
  lines: string[];
  toErr: boolean;
  /** The input line after `lines`. Long prompts have a short input marker here. */
  prompt: string | null;
  state: JoinDrawState;
}

const STEP_INDENT = '   ';
const CODE_INDENT = '  ';
const FIELD_LABEL_WIDTH = 7;

const TYPOGRAPHY: readonly [RegExp, string][] = [
  [/…/g, '...'],
  [/[→⟶]/g, '->'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/ /g, ' '],
];

const plainPunctuation = (text: string): string => TYPOGRAPHY.reduce((t, [from, to]) => t.replace(from, to), text);

// Terminal output from other programs and names from other devices can contain control sequences.
const visibleText = (text: string): string =>
  stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

const indentOf = (step: JoinStep): string => (step === 0 ? '' : STEP_INDENT);

/** A six-digit pairing code in two groups of three. */
export const groupedCode = (code: string): string => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** Wrap at spaces using terminal cells. Keep a word such as a URL intact on its own line. */
export function wrapped(text: string, indent: string, width: number): string[] {
  const room = Math.max(1, width - stringWidth(indent));
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let used = 0;
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const cells = stringWidth(word);
      if (line && used + 1 + cells > room) {
        lines.push(indent + line);
        line = '';
        used = 0;
      }
      if (line) {
        line += ' ';
        used += 1;
      }
      line += word;
      used += cells;
    }
    lines.push(line ? indent + line : '');
  }
  return lines;
}

export function drawJoinEvent(event: DrawEvent, state: JoinDrawState, style: JoinStyle): JoinDrawn {
  const out: string[] = [];
  let { printed, blank } = state;
  const put = (...lines: string[]) => {
    for (const line of lines) {
      out.push(line);
      printed = true;
      blank = line === '';
    }
  };
  const prose = (text: string) => style.plain ? plainPunctuation(visibleText(text)) : visibleText(text);
  const wrap = (text: string, indent: string) => wrapped(prose(text), indent, style.width);
  const accent = (format: 'bold' | 'green' | 'yellow' | 'red', text: string) =>
    !style.plain && style.color && text ? styleText(format, text, { validateStream: false }) : text;
  const labelled = (indent: string, label: string, text: string, format: 'bold' | 'green') => {
    const left = ' '.repeat(stringWidth(indent + label));
    const [first = '', ...rest] = wrap(text, left);
    put(indent + accent(format, label.trimEnd()) + label.slice(label.trimEnd().length) + first.slice(left.length), ...rest);
  };
  const literal = (value: string, indent: string) => put(...visibleText(value).split('\n').map((line) => line ? indent + line : ''));
  const codeIndent = style.width < 48 ? CODE_INDENT : '    ';
  const tick = style.plain ? 'ok: ' : '✓ ';
  const marked = (text: string, indent: string, format: 'bold' | 'yellow' | 'red') => put(...wrap(text, indent).map((line) => accent(format, line)));
  const gap = () => printed && !blank && put('');
  const rendered = (toErr = false, prompt: string | null = null): JoinDrawn => ({ lines: out, toErr, prompt, state: { printed, blank } });

  if (event.event === 'ask') {
    const indent = indentOf(event.step);
    const prompt = indent + prose(event.prompt);
    if (stringWidth(prompt) + 8 <= style.width && !prompt.includes('\n')) return rendered(false, prompt);
    put(...wrap(event.prompt, indent));
    return rendered(false, indent + '> ');
  }
  if (event.event === 'end') {
    gap();
    if (event.ok) labelled('', tick, event.text, 'green');
    else marked(event.text, '', 'red');
    if (event.next) {
      gap();
      const command = visibleText(event.next);
      if (stringWidth(`Next: ${command}`) <= style.width && !command.includes('\n')) put(`Next: ${command}`);
      else {
        put('Next:');
        literal(command, CODE_INDENT);
      }
    }
    return rendered(!event.ok);
  }

  const indent = indentOf(event.step);
  switch (event.kind) {
    case 'heading':
      gap();
      if (event.step === 0) {
        marked(event.text, '', 'bold');
        put('');
      } else labelled('', `${event.step}  `, event.text, 'bold');
      break;
    case 'subheading':
      gap();
      marked(event.text, indent, 'bold');
      break;
    case 'line':
      put(...wrap(event.text, indent));
      break;
    case 'wait':
      gap();
      marked(event.text, indent, 'yellow');
      break;
    case 'field': {
      const label = prose(event.label);
      const value = visibleText(event.value);
      const note = event.note ? `(${prose(event.note)})` : '';
      const spacing = ' '.repeat(Math.max(1, FIELD_LABEL_WIDTH - stringWidth(label)));
      const row = `${indent}${label}${spacing}${value}${note ? `   ${note}` : ''}`;
      if (stringWidth(row) <= style.width && !row.includes('\n')) put(row);
      else {
        put(...wrap(label, indent));
        literal(value, indent + CODE_INDENT);
        if (note) put(...wrapped(note, indent + CODE_INDENT, style.width));
      }
      break;
    }
    case 'code':
      gap();
      literal(groupedCode(event.code), indent + codeIndent);
      put('');
      break;
    case 'done':
      labelled(indent, tick, event.text, 'green');
      break;
    case 'problem':
      gap();
      marked(event.text, indent, 'red');
      put('');
      break;
    case 'quote':
      literal(event.text, indent + codeIndent);
      break;
  }
  return rendered();
}

/** Draws a conversation, including the terminal echo of each supplied answer. */
export function drawJoin(events: readonly DrawEvent[], style: JoinStyle, answers: readonly string[] = []): string[] {
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
