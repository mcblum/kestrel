import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { DEVICE_CODE_EXPIRED } from '../connect/link/identity.ts';
import { JOIN_AGAIN, JOIN_NEXT, type NodeJoinEvent } from '../shared/node-commands.ts';
import { drawJoin, groupedCode, joinStyleOf, nestedEvent, wrapped, type DrawEvent, type JoinStyle } from './join-draw.ts';
import { JOIN_TITLE, LET_IN_WHERE } from './join-flow.ts';

const NAME = 'kestrel-node01';
const FANCY: JoinStyle = { plain: false, width: 100 };
const PLAIN: JoinStyle = { plain: true, width: 100 };

/** What the node says for a join that goes through, as join-flow.ts says it. */
const HAPPY: NodeJoinEvent[] = [
  { event: 'say', step: 0, kind: 'heading', text: JOIN_TITLE(NAME) },
  { event: 'say', step: 1, kind: 'heading', text: 'Sign in' },
  { event: 'say', step: 1, kind: 'field', label: 'Open', value: 'https://id.example/realms/kestrel/device' },
  { event: 'say', step: 1, kind: 'field', label: 'Code', value: 'BHPM-DGDE', note: 'works for 10 minutes' },
  { event: 'say', step: 1, kind: 'wait', text: 'Waiting for you to sign in…' },
  { event: 'say', step: 1, kind: 'done', text: 'Signed in as person@example.com' },
  { event: 'say', step: 2, kind: 'heading', text: 'Let this node in' },
  { event: 'say', step: 2, kind: 'line', text: LET_IN_WHERE(NAME) },
  { event: 'say', step: 2, kind: 'wait', text: 'Waiting for you to choose Let in there…' },
  { event: 'say', step: 2, kind: 'line', text: 'Blum Laptop opened it. Type this code on Blum Laptop:' },
  { event: 'say', step: 2, kind: 'code', code: '731 188' },
  { event: 'say', step: 2, kind: 'done', text: 'Blum Laptop let it in' },
  { event: 'say', step: 3, kind: 'heading', text: 'Confirm' },
  { event: 'say', step: 3, kind: 'line', text: 'Blum Laptop now shows a code of its own. Type it here, so this node knows it was let in by your device.' },
  { event: 'ask', step: 3, prompt: 'Code from Blum Laptop: ' },
  { event: 'end', ok: true, text: `${NAME} is in your account and connected to Kestrel Connect.`, next: JOIN_NEXT },
];

describe('drawJoin', () => {
  test('a join that goes through, in a terminal: three numbered steps, each code on its own line, ticks, the next command', () => {
    expect(drawJoin(HAPPY, FANCY, ['442 999'])).toEqual([
      'Kestrel worker node: join kestrel-node01 to your account',
      '',
      '1  Sign in',
      '   Open   https://id.example/realms/kestrel/device',
      '   Code   BHPM-DGDE   (works for 10 minutes)',
      '',
      '   Waiting for you to sign in…',
      '   ✓ Signed in as person@example.com',
      '',
      '2  Let this node in',
      "   Kestrel on your other devices is showing a request. Choose Let in on kestrel-node01's request",
      "   there, or find it in Settings → Connections.",
      '',
      '   Waiting for you to choose Let in there…',
      '   Blum Laptop opened it. Type this code on Blum Laptop:',
      '',
      '       731 188',
      '',
      '   ✓ Blum Laptop let it in',
      '',
      '3  Confirm',
      '   Blum Laptop now shows a code of its own. Type it here, so this node knows it was let in by your',
      '   device.',
      '   Code from Blum Laptop: 442 999',
      '',
      '✓ kestrel-node01 is in your account and connected to Kestrel Connect.',
      '',
      `Next: ${JOIN_NEXT}`,
    ]);
  });

  test('the same join, piped or with NO_COLOR: the same lines in the same order, in plain ASCII', () => {
    const plain = drawJoin(HAPPY, PLAIN, ['442999']);
    expect(plain).toEqual([
      'Kestrel worker node: join kestrel-node01 to your account',
      '',
      '1  Sign in',
      '   Open   https://id.example/realms/kestrel/device',
      '   Code   BHPM-DGDE   (works for 10 minutes)',
      '',
      '   Waiting for you to sign in...',
      '   ok: Signed in as person@example.com',
      '',
      '2  Let this node in',
      "   Kestrel on your other devices is showing a request. Choose Let in on kestrel-node01's request",
      "   there, or find it in Settings -> Connections.",
      '',
      '   Waiting for you to choose Let in there...',
      '   Blum Laptop opened it. Type this code on Blum Laptop:',
      '',
      '       731 188',
      '',
      '   ok: Blum Laptop let it in',
      '',
      '3  Confirm',
      '   Blum Laptop now shows a code of its own. Type it here, so this node knows it was let in by your',
      '   device.',
      '   Code from Blum Laptop: 442999',
      '',
      'ok: kestrel-node01 is in your account and connected to Kestrel Connect.',
      '',
      `Next: ${JOIN_NEXT}`,
    ]);
    expect(plain.join('\n')).toMatch(/^[\x20-\x7e\n]*$/);
    expect(plain).toHaveLength(drawJoin(HAPPY, FANCY, ['442 999']).length);
  });

  test('a wrong code is a sentence set off by blank lines, says how many tries are left, and the code is asked again', () => {
    const events: NodeJoinEvent[] = [
      { event: 'say', step: 3, kind: 'heading', text: 'Confirm' },
      { event: 'ask', step: 3, prompt: 'Code from Blum Laptop: ' },
      { event: 'say', step: 3, kind: 'problem', text: 'That is not the code Blum Laptop shows. 2 tries left.' },
      { event: 'ask', step: 3, prompt: 'Code from Blum Laptop: ' },
    ];
    expect(drawJoin(events, FANCY, ['000 000', '442 999'])).toEqual([
      '3  Confirm',
      '   Code from Blum Laptop: 000 000',
      '',
      '   That is not the code Blum Laptop shows. 2 tries left.',
      '',
      '   Code from Blum Laptop: 442 999',
    ]);
  });

  test('an expired sign-in ends with its reason, which says to run join again, set off by a blank line', () => {
    const events: NodeJoinEvent[] = [
      { event: 'say', step: 1, kind: 'wait', text: 'Waiting for you to sign in…' },
      { event: 'end', ok: false, text: DEVICE_CODE_EXPIRED },
    ];
    expect(drawJoin(events, PLAIN)).toEqual(['   Waiting for you to sign in...', '', 'The sign-in code expired before anyone signed in with it. Run "kestrel node join" again for a new', 'one.']);
  });

  test('a request that ended says why and what to run', () => {
    const events: NodeJoinEvent[] = [
      { event: 'say', step: 2, kind: 'code', code: '731 188' },
      { event: 'end', ok: false, text: 'Three wrong codes were typed on Blum Laptop. Ask again if this was you.', next: JOIN_AGAIN },
    ];
    expect(drawJoin(events, FANCY)).toEqual(['       731 188', '', 'Three wrong codes were typed on Blum Laptop. Ask again if this was you.', '', `Next: ${JOIN_AGAIN}`]);
  });

  test('a refusal before anything was said is its sentence alone', () => {
    expect(drawJoin([{ event: 'end', ok: false, text: `${NAME} is in your account already. To join it again, remove it from another of your devices first.` }], FANCY)).toEqual([
      `${NAME} is in your account already. To join it again, remove it from another of your devices`,
      'first.',
    ]);
  });

  test('a narrow terminal wraps prose, separates the input line and preserves copyable values', () => {
    const style = joinStyleOf({ isTTY: true, columns: 32 }, { NO_COLOR: '' });
    const url = 'https://id.example/realms/kestrel/device';
    const command = "sudo install -d '/tmp/agent–data'";
    const lines = drawJoin([
      { event: 'say', step: 1, kind: 'heading', text: 'Configure your worker from another device' },
      { event: 'say', step: 1, kind: 'field', label: 'Open', value: url },
      { event: 'say', step: 1, kind: 'code', code: command },
      { event: 'ask', step: 1, prompt: 'Press Enter to check again, or s to skip: ' },
      { event: 'say', step: 1, kind: 'done', text: '設定 完成 ターミナル から 確認 しました' },
      { event: 'say', step: 1, kind: 'quote', text: '\u001b[31mRunning check\u001b[0m' },
      { event: 'end', ok: true, text: 'This worker is ready for your account', next: 'kestrel node configure' },
    ], style, ['s']);
    expect(lines).toContain('   Open');
    expect(lines).toContain('   > s');
    expect(lines).toContain('     Running check');
    expect(lines.filter((line) => stringWidth(line) > style.width)).toEqual([`     ${url}`, `     ${command}`]);
    expect(lines.join('\n')).not.toContain('\u001b');
  });

  test('live color accents preserve the transcript and leave the code and input undecorated', () => {
    const live = drawJoin(HAPPY, { ...FANCY, color: true }, ['442 999']);
    expect(live.map(stripVTControlCharacters)).toEqual(drawJoin(HAPPY, FANCY, ['442 999']));
    expect(live[0]).toContain('\u001b[1m');
    expect(live).toContain('       731 188');
    expect(live).toContain('   Code from Blum Laptop: 442 999');
  });
});

describe('a command inside kestrel node configure: one hierarchy', () => {
  const nested = (events: readonly NodeJoinEvent[], section: 2 | 3 | 4) => events.map((e) => nestedEvent(e, section)).filter((e): e is DrawEvent => e !== null);

  test('the join drawn under its section: no second title, its steps unnumbered subheadings, how it ended a line there', () => {
    const lines = drawJoin([{ event: 'say', step: 2, kind: 'heading', text: 'Account' }, ...nested(HAPPY, 2)], PLAIN, ['442999']);
    expect(lines.slice(0, 5)).toEqual(['2  Account', '', '   Sign in', '   Open   https://id.example/realms/kestrel/device', '   Code   BHPM-DGDE   (works for 10 minutes)']);
    expect(lines).not.toContain(JOIN_TITLE(NAME));
    expect(lines).toContain('   Let this node in');
    expect(lines).toContain('       731 188');
    expect(lines).toContain('   Code from Blum Laptop: 442999');
    expect(lines.at(-1)).toBe('   ok: kestrel-node01 is in your account and connected to Kestrel Connect.');
    expect(lines.join('\n')).not.toContain('Next:');
    // Every line of the command is under the section.
    expect(lines.slice(1).filter((l) => l !== '' && !l.startsWith('   '))).toEqual([]);
  });

  test('a command that did not finish ends as a plain line under its section, not on the error output', () => {
    const [end] = nested([{ event: 'end', ok: false, text: 'Agents on Worker node 1: 0 of 3 can run.', next: 'kestrel node status' }], 3);
    expect(end).toEqual({ event: 'say', step: 3, kind: 'line', text: 'Agents on Worker node 1: 0 of 3 can run.' });
  });
});

describe('the parts', () => {
  test('a six-digit code is shown in two groups of three; anything else as it is', () => {
    expect(groupedCode('731188')).toBe('731 188');
    expect(groupedCode('731 188')).toBe('731 188');
    expect(groupedCode('BHPM-DGDE')).toBe('BHPM-DGDE');
  });

  test('text wraps at spaces under the width, keeping its indent; a long word stands alone', () => {
    expect(wrapped('one two three four', '   ', 12)).toEqual(['   one two', '   three', '   four']);
    expect(wrapped('https://a.very.long.example/address', '   ', 12)).toEqual(['   https://a.very.long.example/address']);
  });

  test('plain unless a terminal that is not dumb and colour is not refused', () => {
    expect(joinStyleOf({ isTTY: true, columns: 120 }, {})).toEqual({ plain: false, width: 100 });
    expect(joinStyleOf({ isTTY: true, columns: 60 }, {})).toEqual({ plain: false, width: 59 });
    expect(joinStyleOf({ isTTY: false }, {})).toEqual({ plain: true, width: 79 });
    expect(joinStyleOf({ isTTY: true }, { NO_COLOR: '' }).plain).toBe(true);
    expect(joinStyleOf({ isTTY: true }, { TERM: 'dumb' }).plain).toBe(true);
    expect(joinStyleOf({ isTTY: true, columns: 10 }, {}).width).toBe(9);
  });
});
