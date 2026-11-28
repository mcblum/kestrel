import { stripVTControlCharacters } from 'node:util';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { WORKER_BIRD, WORKER_BIRD_COMPACT } from './bird.ts';
import type { WorkerAnswer, WorkerDetail, WorkerFrame, WorkerPrompt, WorkerStep } from './model.ts';
import type { WorkerPalette } from './palette.ts';

const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
const oneLine = (value: string) => clean(value).replace(/\s+/g, ' ').trim();
const wrap = (value: string, width: number, literal = false) =>
  wrapAnsi(clean(value).replaceAll('\t', '    '), Math.max(1, width), {
    hard: true, wordWrap: !literal, trim: !literal,
  }).split('\n');

function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = () => setSize(read());
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);
  return size;
}

const STEP_MARK = { pending: '·', active: '›', ready: '✓', left: '○' };
const STEP_LABEL = { pending: 'upcoming', active: 'current', ready: 'ready', left: 'left to do' };

function Progress({ steps, palette, width }: { steps: readonly WorkerStep[]; palette: WorkerPalette; width: number }) {
  const active = steps.findIndex((step) => step.state === 'active');
  const full = steps.map((step) => `${STEP_MARK[step.state]} ${oneLine(step.label)}`).join('   ');
  if (active >= 0 && stringWidth(full) > width) {
    return <Text bold color={palette.ink} wrap="truncate-end">{active + 1} of {steps.length}  /  {oneLine(steps[active]!.label)}</Text>;
  }
  return (
    <Text wrap="truncate-end" aria-label={steps.map((step) => `${oneLine(step.label)} ${STEP_LABEL[step.state]}`).join(', ')}>
      {steps.map((step, index) => (
        <Text key={index} bold={step.state === 'active'} color={step.state === 'active' ? palette.ink : palette.muted}>
          {index === 0 ? '' : '   '}
          <Text color={step.state === 'ready' ? palette.ready : step.state === 'left' ? palette.caution : undefined}>{STEP_MARK[step.state]}</Text>
          {' '}{oneLine(step.label)}
        </Text>
      ))}
    </Text>
  );
}

function Masthead({ frame, palette, compact, minimal }: { frame: WorkerFrame; palette: WorkerPalette; compact: boolean; minimal: boolean }) {
  if (minimal) return <Text bold color={palette.ink} wrap="truncate-end">kestrel  /  {oneLine(frame.name)}</Text>;
  const bird = compact ? WORKER_BIRD_COMPACT : WORKER_BIRD;
  return (
    <Box alignItems="center" gap={compact ? 1 : 3}>
      <Box flexDirection="column" flexShrink={0} aria-hidden>
        {bird.map((line) => <Text key={line} color={palette.bird} backgroundColor={palette.tile}>{' '}{line}{' '}</Text>)}
      </Box>
      <Box flexDirection="column" minWidth={0}>
        <Text bold color={palette.ink}>kestrel</Text>
        <Text bold color={palette.ink} wrap="truncate-end">{oneLine(frame.name)}</Text>
        <Text color={palette.muted} wrap="truncate-middle">{oneLine(frame.node)}</Text>
      </Box>
    </Box>
  );
}

type DisplayRow = {
  text: string;
  tone?: 'muted' | 'ready' | 'caution' | 'problem';
  bold?: boolean;
  /** Drawn muted before `text`: a field's label column. */
  label?: string;
};

/** Below this width a trust detail's labels stand above their values instead of in a column beside them. */
const LABEL_COLUMN_MIN = 48;
/** Commands sit indented under their heading, as one block. */
const COMMAND_INDENT = '    ';

/** `headed`: the first detail's label is already the frame's heading (an approval), so it is not drawn again. */
function detailRows(details: readonly WorkerDetail[], width: number, headed = false): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const put = (value: string, options: Omit<DisplayRow, 'text'> = {}, indent = '', literal = false) => {
    for (const text of wrap(value, width - stringWidth(indent), literal)) rows.push({ text: indent + text, ...options });
  };
  /** A label in a muted column and its value beside it, wrapped under itself; or, when narrow, the label above it. */
  const column = (label: string, value: string, labelWidth: number) => {
    const lead = oneLine(label).padEnd(labelWidth) + '  ';
    if (width < LABEL_COLUMN_MIN) {
      // Narrow: each label is a small bold heading over its value, the groups a line apart.
      if (rows.length > 0 && rows.at(-1)!.text !== '') rows.push({ text: '' });
      rows.push({ text: oneLine(label), bold: true, tone: 'muted' });
      put(value);
      return;
    }
    const hang = ' '.repeat(stringWidth(lead));
    wrap(value, width - stringWidth(lead)).forEach((text, i) => rows.push({ text, label: i === 0 ? lead : hang }));
  };
  const field = (label: string, value: string, literal = false, labelWidth = 0) => {
    const lead = oneLine(label).padEnd(labelWidth);
    // Long values get the full width and begin at the same place on each line.
    if (stringWidth(lead + '  ' + value) <= width && !value.includes('\n')) {
      put(lead + '  ' + value, { bold: literal }, '', true);
    } else if (literal) {
      put(lead, { tone: 'muted' });
      put(value, { bold: literal }, '', literal);
    } else {
      put(lead + '  ' + value);
    }
  };
  details.forEach((detail, index) => {
    switch (detail.kind) {
      case 'text':
        put(detail.text);
        break;
      case 'problem':
        put('!  ' + detail.text, { tone: 'problem' });
        break;
      case 'literal':
        put(detail.value, { bold: true }, '', true);
        break;
      case 'field':
        field(detail.label, detail.value, true);
        if (detail.note) put(detail.note, { tone: 'muted' });
        break;
      case 'trust':
        if (!(headed && index === 0)) put(detail.label, { tone: 'caution', bold: true });
        column('Action', detail.action, 6);
        column('Where', detail.destination, 6);
        column('Why', detail.reason, 6);
        if (detail.commands?.length) {
          // Set apart from the prose: a gap, its own heading, and the commands as one indented block.
          rows.push({ text: '' });
          put(detail.commands.length === 1 ? 'Command' : 'Commands', { bold: true });
          rows.push({ text: '' });
          for (const command of detail.commands) put(command, { bold: true }, width < LABEL_COLUMN_MIN ? '  ' : COMMAND_INDENT, true);
        }
        break;
      case 'handoff':
        put('Terminal handoff  /  ' + detail.program, { tone: 'caution', bold: true });
        put(detail.detail);
        break;
      case 'outcome':
        put((detail.state === 'ready' ? '✓  ' : '○  ') + detail.label, { tone: detail.state === 'ready' ? 'ready' : 'caution', bold: true });
        if (detail.detail) put(detail.detail, {}, '   ');
        if (detail.command) put(detail.command, { bold: true }, '   ', true);
        break;
    }
    const next = details[index + 1];
    if (next && (detail.kind === 'trust' || detail.kind === 'handoff' || next.kind === 'trust' || next.kind === 'handoff')) rows.push({ text: '' });
  });
  return rows;
}

const segmenter = new Intl.Segmenter();
const characters = (value: string) => [...segmenter.segment(value)].map(({ segment }) => segment);

function inputLine(value: string[], cursor: number, placeholder: string, width: number, palette: WorkerPalette) {
  if (value.length === 0 && placeholder) {
    return <Text wrap="truncate-end"><Text bold>› </Text><Text color={palette.muted}>{placeholder}</Text></Text>;
  }
  let before = value.slice(0, cursor);
  const current = value[cursor] ?? ' ';
  while (stringWidth(before.join('')) + stringWidth(current) >= width - 2) before = before.slice(1);
  return <Text wrap="truncate-end"><Text bold>› </Text>{before.join('')}<Text inverse>{current}</Text>{value.slice(cursor + 1).join('')}</Text>;
}

function WorkerScreenState({ frame, prompt, palette, onAnswer, onCancel, live }:
  { frame: WorkerFrame; prompt?: WorkerPrompt; palette: WorkerPalette; onAnswer: (answer: WorkerAnswer) => void; onCancel: () => void; live: boolean }) {
  const { columns, rows } = useTerminalSize();
  const compact = columns < 55 || rows < 26;
  const minimal = rows < 21 || columns < 27;
  const inset = compact ? 1 : 2;
  const width = Math.max(8, Math.min(76, columns - 1 - 2 * inset));
  const choices = prompt && prompt.kind !== 'input' ? prompt.choices : [];
  const [focus, setFocus] = useState(() => prompt?.kind === 'select' ? Math.max(0, choices.findIndex((choice) => choice.value === prompt.initial)) : 0);
  const [selected, setSelected] = useState(() => new Set(prompt?.kind === 'multi' ? prompt.initial : []));
  const [value, setValue] = useState(() => prompt?.kind === 'input' ? characters(clean(prompt.initial ?? '')) : []);
  const [cursor, setCursor] = useState(value.length);
  // Null follows the newest lines; an approval starts at its top, where the trust detail is.
  const [offset, setOffset] = useState<number | null>(null);
  const headerRows = minimal ? 1 : compact ? WORKER_BIRD_COMPACT.length : WORKER_BIRD.length;
  // An approval's name joins the section on one heading line; where both do not fit, the progress line names the section.
  const approval = frame.details?.[0]?.kind === 'trust' ? oneLine(frame.details[0].label) : '';
  const joined = approval ? `${oneLine(frame.title)}: ${approval}` : oneLine(frame.title);
  const title = wrap(approval && stringWidth(joined) > width ? approval : joined, width);
  const description = frame.description ? wrap(frame.description, width).map((text): DisplayRow => ({ text, tone: 'muted' })) : [];
  const body = detailRows(frame.details ?? [], width, Boolean(approval));
  const gap: DisplayRow[] = description.length && body.length ? [{ text: '' }] : [];
  const trustFirst = compact && frame.details?.[0]?.kind === 'trust';
  const details = trustFirst ? [...body, ...gap, ...description] : [...description, ...gap, ...body];
  const question = prompt && prompt.label !== frame.title ? wrap(oneLine(prompt.label), width) : [];
  const status = frame.status ? wrap('…  ' + frame.status, width) : [];
  const optionsShown = Math.min(choices.length, Math.max(2, Math.min(6, rows - headerRows - title.length - question.length - 13)));
  const start = Math.max(0, Math.min(focus - Math.floor(optionsShown / 2), choices.length - optionsShown));
  const focused = choices[focus];
  const note = oneLine(focused?.note ?? '');
  const noteBelow = focused && note && stringWidth(oneLine(focused.label)) + stringWidth(note) + (prompt?.kind === 'multi' ? 8 : 4) > width
    ? wrap(note, width - 2).slice(0, 2) : [];
  const shortcut = prompt?.kind === 'multi' ? '↑↓ Move   Space Toggle   Enter Apply'
    : prompt?.kind === 'select' ? '↑↓ Move   Enter Select'
      : prompt?.kind === 'input' ? 'Enter Submit' : '';
  const keys = [shortcut, prompt?.cancelable ? 'Esc Cancel' : '', live ? 'Ctrl+C Stop' : ''].filter(Boolean).join('   ');
  const footer = keys ? wrap(keys, width) : [];
  const controls = prompt ? question.length + (prompt.kind === 'input' ? 1 : optionsShown + noteBelow.length + (choices.length > optionsShown ? 1 : 0)) + 1 : 0;
  const footerMargin = compact ? 0 : 1;
  // A blank row sets the heading off from the text under it.
  const headingGap = details.length > 0 || status.length > 0 ? 1 : 0;
  const fixedRows = headerRows + (frame.steps?.length ? 2 : 0) + 1 + title.length + headingGap + status.length + controls + (footer.length ? footer.length + 1 + footerMargin : 0);
  const room = Math.max(2, rows - fixedRows - 1);
  const overflow = live && details.length > room;
  const pageSize = overflow ? room - 1 : details.length;
  const lastOffset = overflow ? Math.max(0, details.length - pageSize) : 0;
  const from = Math.min(offset ?? (frame.details?.[0]?.kind === 'trust' ? 0 : lastOffset), lastOffset);
  const end = Math.min(details.length, from + pageSize);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onCancel();
    if (key.pageUp || key.pageDown) {
      setOffset(Math.max(0, Math.min(lastOffset, from + (key.pageUp ? -pageSize : pageSize))));
      return;
    }
    if (!prompt || key.ctrl) return;
    if (key.escape && prompt.cancelable) return onAnswer(null);
    if (prompt.kind === 'input') {
      if (key.return) return onAnswer(value.join(''));
      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));
      if (key.home) return setCursor(0);
      if (key.end) return setCursor(value.length);
      // Ink reports the DEL byte sent by many terminals' Backspace as delete.
      if ((key.backspace || key.delete) && cursor > 0) {
        setValue([...value.slice(0, cursor - 1), ...value.slice(cursor)]);
        return setCursor(cursor - 1);
      }
      if (key.meta || key.tab || key.backspace || key.delete) return;
      // Pasted text arrives as one chunk; a line break in it is Enter, and what follows it is dropped.
      const lineEnd = input.search(/[\r\n]/);
      const typed = lineEnd >= 0 ? input.slice(0, lineEnd) : input;
      const added = characters(clean(typed).replace(/\t/g, '')).slice(0, Math.max(0, (prompt.maxLength ?? 4096) - value.length));
      const next = [...value.slice(0, cursor), ...added, ...value.slice(cursor)];
      if (lineEnd >= 0) return onAnswer(next.join(''));
      if (added.length) {
        setValue(next);
        setCursor(cursor + added.length);
      }
      return;
    }
    if (key.upArrow) return setFocus(Math.max(0, focus - 1));
    if (key.downArrow) return setFocus(Math.min(Math.max(0, choices.length - 1), focus + 1));
    if (key.home) return setFocus(0);
    if (key.end) return setFocus(Math.max(0, choices.length - 1));
    const choice = choices[focus];
    if (prompt.kind === 'multi') {
      if (key.return) return onAnswer(choices.filter((item) => selected.has(item.value)).map((item) => item.value));
      if (input === ' ' && choice) {
        const next = new Set(selected);
        if (!next.delete(choice.value)) next.add(choice.value);
        setSelected(next);
      }
      return;
    }
    const picked = key.return ? choice : choices.find((item) => item.shortcut === input);
    if (picked) onAnswer(picked.value);
  }, { isActive: live });

  return (
    <Box width={width + 2 * inset} paddingX={inset} flexDirection="column">
      <Masthead frame={frame} palette={palette} compact={compact} minimal={minimal} />
      {Boolean(frame.steps?.length) && <Box marginTop={1}><Progress steps={frame.steps!} width={width} palette={palette} /></Box>}
      <Box marginTop={1} flexDirection="column">
        {title.map((text, i) => <Text key={i} bold color={palette.ink}>{text}</Text>)}
        {headingGap > 0 && <Text> </Text>}
        {details.slice(from, end).map((row, i) => (
          <Text key={from + i} bold={row.bold} color={row.tone ? palette[row.tone] : palette.ink}>
            {row.label !== undefined && <Text color={palette.muted} bold={false}>{row.label}</Text>}
            {row.text || (row.label ? '' : ' ')}
          </Text>
        ))}
        {overflow && <Text color={palette.muted} wrap="truncate-end">PgUp/PgDn · {from + 1}–{end} of {details.length}</Text>}
        {status.map((text, i) => <Text key={i} color={palette.muted}>{text}</Text>)}
      </Box>
      {prompt && (
        <Box flexDirection="column" marginTop={1}>
          {question.map((text, i) => <Text key={i} bold color={palette.ink}>{text}</Text>)}
          {prompt.kind === 'input' ? inputLine(value, cursor, oneLine(prompt.placeholder ?? ''), width, palette) : (
            <Box flexDirection="column" aria-role="listbox" aria-state={{ multiselectable: prompt.kind === 'multi' }}>
              {choices.slice(start, start + optionsShown).map((choice, index) => {
                const focused = start + index === focus;
                const checked = selected.has(choice.value);
                const lead = (focused ? '› ' : '  ') + (prompt.kind === 'multi' ? (checked ? '[x] ' : '[ ] ') : '');
                const label = oneLine(choice.label);
                const note = oneLine(choice.note ?? '');
                const inline = note && stringWidth(lead + label + '  ' + note) <= width;
                return (
                  <Text
                    key={choice.value}
                    bold={focused}
                    color={focused ? palette.selectedInk : palette.ink}
                    backgroundColor={focused ? palette.selected : undefined}
                    wrap="truncate-end"
                    aria-label={`${label}${prompt.kind === 'multi' ? checked ? ', selected' : ', unselected' : ''}${note ? ', ' + note : ''}`}
                  >
                    {lead}{label}{inline && <Text color={focused ? palette.selectedInk : palette.muted}>{'  '}{note}</Text>}
                  </Text>
                );
              })}
              {noteBelow.map((line, index) => <Text key={index} color={palette.muted}>{'  '}{line}</Text>)}
              {choices.length > optionsShown && <Text color={palette.muted}>{start + 1}–{start + optionsShown} of {choices.length} choices</Text>}
            </Box>
          )}
        </Box>
      )}
      {footer.length > 0 && (
        <Box flexDirection="column" marginTop={footerMargin}>
          <Text color={palette.border} aria-hidden>{'─'.repeat(width)}</Text>
          {footer.map((text, i) => <Text key={i} color={palette.muted}>{text}</Text>)}
        </Box>
      )}
    </Box>
  );
}

export function WorkerScreen(props: Parameters<typeof WorkerScreenState>[0]) {
  return <WorkerScreenState key={props.prompt?.id ?? props.frame.title} {...props} />;
}
