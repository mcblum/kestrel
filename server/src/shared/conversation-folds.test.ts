import { describe, expect, it } from 'vitest';
import { askedLine, foldConversation, foldRoles, outcomeOf, outcomeText, PICTURE_GROUP_WINDOW_MS, sortOf, summarizeApprovals, type FoldCard, type FoldMessage } from './conversation-folds.ts';

const T0 = 1_700_000_000_000;
const pic = (name: string, at?: number): FoldMessage => ({ author: 'agent', text: '', images: [name], ...(at === undefined ? {} : { at }) });
const steps = (): FoldMessage => ({ author: 'agent', text: '', activity: [{ id: 't' }] });
const prose = (text: string): FoldMessage => ({ author: 'agent', text });
const user = (text: string): FoldMessage => ({ author: 'you', text });

const OPTIONS: FoldCard['options'] = [
  { label: 'Allow', role: 'allow' },
  { label: 'Always allow in this session', role: 'allow' },
  { label: 'Deny', role: 'deny' },
];
const card = (resolved: string | undefined, over: Partial<FoldCard> = {}): FoldCard => ({ kind: 'approval', tool: 'Bash', title: 'Run a command', detail: 'List the files\n\nls -la', options: OPTIONS, ...(resolved ? { resolved } : {}), ...over });
const asked = (resolved: string | undefined, over: Partial<FoldCard> = {}): FoldMessage => ({ author: 'agent', text: '', input: card(resolved, over) });
const allowed = (over: Partial<FoldCard> = {}) => asked('Allow', over);

describe('foldConversation: pictures', () => {
  it('groups pictures taken one after another, with the tool lines around them', () => {
    const messages = [steps(), pic('a', T0), steps(), pic('b', T0 + 5_000), steps(), pic('c', T0 + 9_000), steps()];
    expect(foldConversation(messages)).toEqual([
      {
        start: 0,
        members: [0, 1, 2, 3, 4, 5, 6],
        pictures: [
          { message: 1, name: 'a' },
          { message: 3, name: 'b' },
          { message: 5, name: 'c' },
        ],
        approvals: [],
        steps: [0, 2, 4, 6],
      },
    ]);
  });

  it('leaves a single picture and its tool lines alone', () => {
    expect(foldConversation([steps(), pic('a', T0), steps(), prose('Looks right.')])).toEqual([]);
  });

  it('groups several pictures from one tool result', () => {
    const folds = foldConversation([{ author: 'agent', text: '', images: ['a', 'b'], at: T0 }]);
    expect(folds.map((f) => f.pictures.map((p) => p.name))).toEqual([['a', 'b']]);
  });

  it('breaks at agent prose and at a user message', () => {
    const messages = [pic('a', T0), pic('b', T0 + 1), prose('The sign-in screen is wrong.'), pic('c', T0 + 2), pic('d', T0 + 3), user('Go on'), pic('e', T0 + 4), pic('f', T0 + 5)];
    expect(foldConversation(messages).map((f) => f.members)).toEqual([
      [0, 1],
      [3, 4],
      [6, 7],
    ]);
  });

  it('breaks at a card or a notice', () => {
    const list: FoldMessage = { author: 'agent', text: '', todos: [{}] };
    const notice: FoldMessage = { author: 'agent', text: 'The tool failed', notice: 'error' };
    expect(foldConversation([pic('a', T0), list, pic('b', T0 + 1)])).toEqual([]);
    expect(foldConversation([pic('a', T0), notice, pic('b', T0 + 1)])).toEqual([]);
  });

  it('does not take a picture that comes with text', () => {
    const captioned: FoldMessage = { author: 'agent', text: 'Here it is', images: ['b'], at: T0 + 1 };
    expect(foldConversation([pic('a', T0), captioned, pic('c', T0 + 2)])).toEqual([]);
  });

  it('starts a new fold when a picture is further than the window from the previous one', () => {
    const messages = [pic('a', T0), pic('b', T0 + PICTURE_GROUP_WINDOW_MS), pic('c', T0 + 2 * PICTURE_GROUP_WINDOW_MS + 1), pic('d', T0 + 2 * PICTURE_GROUP_WINDOW_MS + 2)];
    expect(foldConversation(messages).map((f) => f.members)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('measures the window from the previous picture, not the first', () => {
    const step = PICTURE_GROUP_WINDOW_MS - 1;
    const messages = [pic('a', T0), pic('b', T0 + step), pic('c', T0 + 2 * step), pic('d', T0 + 3 * step)];
    expect(foldConversation(messages).map((f) => f.members)).toEqual([[0, 1, 2, 3]]);
  });

  it('groups older pictures without timestamps by adjacency', () => {
    expect(foldConversation([pic('a'), steps(), pic('b')]).map((f) => f.members)).toEqual([[0, 1, 2]]);
    expect(foldConversation([pic('a'), prose('…'), pic('b')])).toEqual([]);
  });

  it('takes a custom window', () => {
    expect(foldConversation([pic('a', T0), pic('b', T0 + 10)], 5)).toEqual([]);
  });
});

describe('foldConversation: approvals', () => {
  it('folds a run of answered approvals, with the tool lines between them', () => {
    const messages = [user('go'), steps(), allowed(), steps(), allowed(), steps(), asked('Deny'), prose('Done.')];
    expect(foldConversation(messages)).toEqual([{ start: 1, members: [1, 2, 3, 4, 5, 6], pictures: [], approvals: [2, 4, 6], steps: [1, 3, 5] }]);
  });

  it('folds a single answered approval too, so it reads the same compact way', () => {
    expect(foldConversation([allowed()]).map((f) => f.approvals)).toEqual([[0]]);
  });

  it('ends the run at a card still waiting, and leaves that card as it is', () => {
    const messages = [allowed(), steps(), allowed(), steps(), asked(undefined), steps()];
    const folds = foldConversation(messages);
    expect(folds.map((f) => f.members)).toEqual([[0, 1, 2, 3]]);
    expect(foldRoles(folds).get(4)).toBeUndefined();
  });

  it('keeps plans and questions out, and lets them end the run', () => {
    const plan = asked('Approve, accept edits', { tool: 'ExitPlanMode', markdown: true });
    const question: FoldMessage = { author: 'agent', text: '', input: { ...card('Blue'), kind: 'question', tool: 'AskUserQuestion' } };
    expect(foldConversation([allowed(), plan, allowed()]).map((f) => f.members)).toEqual([[0], [2]]);
    expect(foldConversation([allowed(), question, allowed()]).map((f) => f.members)).toEqual([[0], [2]]);
  });

  it('needs no time window between approvals', () => {
    const late = (at: number): FoldMessage => ({ ...allowed(), at });
    expect(foldConversation([late(T0), late(T0 + 10 * PICTURE_GROUP_WINDOW_MS)]).map((f) => f.approvals)).toEqual([[0, 1]]);
  });

  it('makes the real stretch one fold: approve, tool line, screenshot, over and over', () => {
    const messages: FoldMessage[] = [prose('Testing the app.')];
    for (let i = 0; i < 4; i++) messages.push(steps(), allowed({ tool: 'mcp__kestrel__sim_tap' }), pic(`shot-${i}`, T0 + i * 3_000));
    messages.push(prose('All screens checked.'));
    const folds = foldConversation(messages);
    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({ start: 1, approvals: [2, 5, 8, 11], steps: [1, 4, 7, 10] });
    expect(folds[0]!.pictures.map((p) => p.name)).toEqual(['shot-0', 'shot-1', 'shot-2', 'shot-3']);
    expect(folds[0]!.members).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('keeps a lone picture inside a fold that has approvals', () => {
    const [fold] = foldConversation([allowed(), steps(), pic('a', T0)]);
    expect(fold!.pictures).toEqual([{ message: 2, name: 'a' }]);
  });
});

describe('foldConversation: the text before a fold', () => {
  const said = (text: string): FoldMessage => ({ author: 'agent', text, activity: [{ id: 'first-tap' }] });

  it('takes the tool lines of the text just before it, so the stretch has one steps line', () => {
    const messages = [user('go'), said('Testing the app.'), allowed(), steps(), allowed(), prose('Done.')];
    const [fold] = foldConversation(messages);
    expect(fold).toMatchObject({ start: 2, lead: 1, steps: [3] });
    expect(foldRoles([fold!]).get(1)).toEqual({ kind: 'text-only' });
  });

  it('leaves text alone when what follows is not folded, or when the text has no tool lines', () => {
    expect(foldConversation([said('Looking.'), steps(), pic('a', T0), prose('ok')])).toEqual([]);
    expect(foldConversation([prose('Testing.'), allowed()])[0]!.lead).toBeUndefined();
    expect(foldConversation([allowed()])[0]!.lead).toBeUndefined();
  });

  it('does not take tool lines from a message that is also a card or a notice', () => {
    const notice: FoldMessage = { ...said('Failed'), notice: 'error' };
    expect(foldConversation([notice, allowed()])[0]!.lead).toBeUndefined();
  });
});

describe('foldRoles', () => {
  it('draws the fold at its first message and folds the rest away', () => {
    const folds = foldConversation([prose('x'), pic('a', T0), steps(), pic('b', T0 + 1), prose('y')]);
    const roles = foldRoles(folds);
    expect(roles.get(0)).toBeUndefined();
    expect(roles.get(1)).toEqual({ kind: 'fold', fold: folds[0] });
    expect(roles.get(2)).toEqual({ kind: 'folded' });
    expect(roles.get(3)).toEqual({ kind: 'folded' });
    expect(roles.get(4)).toBeUndefined();
  });
});

describe('answered approvals in words', () => {
  it('reads the outcome from the option chosen', () => {
    expect(outcomeOf(card('Allow'))).toBe('allowed');
    expect(outcomeOf(card('Always allow in this session'))).toBe('allowed');
    expect(outcomeOf(card('Deny'))).toBe('denied');
    expect(outcomeOf(card('Interrupted by restart'))).toBe('other');
  });

  it('names what the approvals were for', () => {
    expect(sortOf('Bash')).toBe('command');
    expect(sortOf('Edit')).toBe('edit');
    expect(sortOf('mcp__kestrel__browser_click')).toBe('browser');
    expect(sortOf('mcp__kestrel__sim_tap')).toBe('simulator');
    expect(sortOf('delegate')).toBe('action');
  });

  it('counts a run in one line, with denials and unanswered ones kept visible', () => {
    const run = (labels: string[], tool = 'Bash') => summarizeApprovals(labels.map((l) => card(l, { tool })));
    expect(run(Array(12).fill('Allow')).text).toBe('12 commands allowed');
    expect(run([...Array(9).fill('Allow'), 'Deny']).text).toBe('9 commands allowed · 1 denied');
    expect(run(['Allow'], 'Edit').text).toBe('1 edit allowed');
    expect(run(['Deny', 'Deny'], 'mcp__kestrel__browser_click').text).toBe('2 browser actions denied');
    expect(run(['Allow', 'Allow', 'Interrupted by restart'], 'mcp__kestrel__sim_tap')).toEqual({
      text: '2 simulator actions allowed · 1 not answered',
      parts: [
        { text: '2 simulator actions allowed', outcome: 'allowed' },
        { text: '1 not answered', outcome: 'other' },
      ],
      allowed: 2,
      denied: 0,
      other: 1,
    });
  });

  it('counts a mixed run as actions', () => {
    expect(summarizeApprovals([card('Allow'), card('Allow', { tool: 'Edit' }), card('Deny', { tool: 'mcp__kestrel__sim_tap' })]).text).toBe('2 actions allowed · 1 denied');
  });

  it('says what was asked in one line: the command for a command, the title otherwise', () => {
    expect(askedLine(card('Allow'))).toBe('ls -la');
    expect(askedLine(card('Allow', { detail: 'pnpm test \\\n  --run' }))).toBe('pnpm test \\');
    expect(askedLine(card('Allow', { tool: 'Edit', title: 'Edit src/a.ts', detail: '- a\n+ b' }))).toBe('Edit src/a.ts');
    expect(askedLine(card('Allow', { detail: '' }))).toBe('Run a command');
  });

  it('says the outcome as plain words', () => {
    expect(outcomeText(card('Allow'))).toBe('allowed');
    expect(outcomeText(card('Deny'))).toBe('denied');
    expect(outcomeText(card('Always allow in this session'))).toBe('Always allow in this session');
    expect(outcomeText(card('Interrupted by restart'))).toBe('Interrupted by restart');
  });
});
