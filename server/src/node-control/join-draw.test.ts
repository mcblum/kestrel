import { describe, expect, test } from 'vitest';
import { DEVICE_CODE_EXPIRED } from '../connect/link/identity.ts';
import { JOIN_AGAIN, JOIN_NEXT, type NodeJoinEvent } from '../shared/node-commands.ts';
import { drawJoin, groupedCode, joinStyleOf, wrapped, type JoinStyle } from './join-draw.ts';
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
  { event: 'say', step: 2, kind: 'line', text: 'Blum Laptop opened it. Type this code there:' },
  { event: 'say', step: 2, kind: 'code', code: '731 188' },
  { event: 'say', step: 2, kind: 'done', text: 'Blum Laptop let it in' },
  { event: 'say', step: 3, kind: 'heading', text: 'Confirm' },
  { event: 'ask', step: 3, prompt: 'Type the code Blum Laptop shows now: ' },
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
      "   On a device already in your account, open Kestrel → Settings → Connections and choose Let in on",
      "   kestrel-node01's request.",
      '',
      '   Waiting for you to choose Let in there…',
      '   Blum Laptop opened it. Type this code there:',
      '',
      '       731 188',
      '',
      '   ✓ Blum Laptop let it in',
      '',
      '3  Confirm',
      '   Type the code Blum Laptop shows now: 442 999',
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
      "   On a device already in your account, open Kestrel -> Settings -> Connections and choose Let in on",
      "   kestrel-node01's request.",
      '',
      '   Waiting for you to choose Let in there...',
      '   Blum Laptop opened it. Type this code there:',
      '',
      '       731 188',
      '',
      '   ok: Blum Laptop let it in',
      '',
      '3  Confirm',
      '   Type the code Blum Laptop shows now: 442999',
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
      { event: 'ask', step: 3, prompt: 'Type the code Blum Laptop shows now: ' },
      { event: 'say', step: 3, kind: 'problem', text: 'That is not the code Blum Laptop shows. 2 tries left.' },
      { event: 'ask', step: 3, prompt: 'Type the code Blum Laptop shows now: ' },
    ];
    expect(drawJoin(events, FANCY, ['000 000', '442 999'])).toEqual([
      '3  Confirm',
      '   Type the code Blum Laptop shows now: 000 000',
      '',
      '   That is not the code Blum Laptop shows. 2 tries left.',
      '',
      '   Type the code Blum Laptop shows now: 442 999',
    ]);
  });

  test('an expired sign-in ends with its reason, which says to run join again, set off by a blank line', () => {
    const events: NodeJoinEvent[] = [
      { event: 'say', step: 1, kind: 'wait', text: 'Waiting for you to sign in…' },
      { event: 'end', ok: false, text: DEVICE_CODE_EXPIRED },
    ];
    expect(drawJoin(events, PLAIN)).toEqual(['   Waiting for you to sign in...', '', 'The sign-in code expired before anyone signed in with it. Run "kestrel-node join" again for a new', 'one.']);
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
    expect(joinStyleOf({ isTTY: true, columns: 10 }, {}).width).toBe(40);
  });
});
