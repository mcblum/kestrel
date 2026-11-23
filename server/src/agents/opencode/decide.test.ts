// Kestrel's answer to each OpenCode permission ask, by level. Pure.
import { describe, expect, it } from 'vitest';
import type { PermissionLevel } from '../../shared/permissions.ts';
import { CHANGES_NOTHING, decide, readAsk, type Ask, type DecideContext } from './decide.ts';
import type { ToolCall } from './map.ts';
import { opencodePolicy, sessionRules } from './policy.ts';

const DIR = '/work/alpha';
const ctx = (level: PermissionLevel, extra: Partial<DecideContext> = {}): DecideContext => ({ policy: opencodePolicy(level), directory: DIR, root: DIR, confined: false, readable: [], ...extra });
const ask = (permission: string, patterns: string[], metadata: Record<string, unknown> = {}): Ask => readAsk({ id: 'per_1', sessionID: 'ses_1', permission, patterns, metadata, tool: { messageID: 'm', callID: 'c' } })!;
const call = (tool: string, input: Record<string, unknown>): ToolCall => ({ tool, input, sessionID: 'ses_1' });
const kind = (d: ReturnType<typeof decide>) => (d.kind === 'card' ? 'card' : d.answer.reply);

describe('decide', () => {
  const editIn = ask('edit', ['notes.txt'], { filepath: `${DIR}/notes.txt` });
  const editOut = ask('edit', ['/elsewhere/x.txt'], { filepath: '/elsewhere/x.txt' });
  const bash = ask('bash', ['rm -rf build']);
  const bashCall = call('bash', { command: 'rm -rf build' });

  it.each([
    ['ask', 'card', 'card', 'card'],
    ['edits', 'once', 'card', 'card'],
    ['auto', 'once', 'once', 'once'],
    ['bypass', 'once', 'once', 'once'],
    ['plan', 'reject', 'reject', 'card'],
    ['readonly', 'reject', 'reject', 'reject'],
  ] as const)('%s: an edit in the folder → %s, outside → %s; a command → %s', (level, inside, outside, command) => {
    expect(kind(decide(editIn, undefined, ctx(level)))).toBe(inside);
    expect(kind(decide(editOut, undefined, ctx(level)))).toBe(outside);
    expect(kind(decide(bash, bashCall, ctx(level)))).toBe(command);
  });

  it('a refusal in Plan and Read only tells the agent what to do instead', () => {
    expect(decide(editIn, undefined, ctx('readonly'))).toEqual({ kind: 'reply', answer: { reply: 'reject', message: CHANGES_NOTHING } });
  });

  it("a confined child's edit outside its worktree is a card even in Auto; inside it runs", () => {
    expect(kind(decide(editOut, undefined, ctx('auto', { confined: true })))).toBe('card');
    expect(kind(decide(editIn, undefined, ctx('auto', { confined: true })))).toBe('once');
  });

  it('a card shows the call and the diff, and its answers become replies', () => {
    const d = decide(editIn, call('edit', { filePath: `${DIR}/notes.txt`, oldString: 'two', newString: 'three' }), ctx('ask'));
    if (d.kind !== 'card') throw new Error('expected a card');
    expect(d.request).toMatchObject({ kind: 'approval', tool: 'edit' });
    expect(d.reply({ optionId: 'allow' })).toEqual({ reply: 'once' });
    expect(d.reply({ optionId: 'deny', text: 'not now' })).toEqual({ reply: 'reject', message: 'The user declined this: not now' });
  });

  it('reaching outside the folder: reads are allowed; a command runs in Auto and Bypass, and asks in Manual and in a session another session started', () => {
    const outside = ask('external_directory', ['/etc/*'], { filepath: '/etc/hosts' });
    expect(kind(decide(outside, call('read', { filePath: '/etc/hosts' }), ctx('ask')))).toBe('once');
    const cmd = ask('external_directory', ['/tmp/*']);
    expect(kind(decide(cmd, call('bash', { command: 'ls /tmp' }), ctx('auto')))).toBe('once');
    expect(kind(decide(cmd, call('bash', { command: 'ls /tmp' }), ctx('auto', { confined: true })))).toBe('card');
    expect(kind(decide(cmd, call('bash', { command: 'ls /tmp' }), ctx('ask')))).toBe('card');
    expect(kind(decide(cmd, call('bash', { command: 'ls /tmp' }), ctx('bypass')))).toBe('once');
  });

  it('Read only: a read outside the readable folders is refused with the confinement reason', () => {
    const outside = ask('external_directory', ['/private/*'], { filepath: '/private/secret' });
    const d = decide(outside, call('read', { filePath: '/private/secret' }), ctx('readonly'));
    expect(d.kind === 'reply' && d.answer.reply).toBe('reject');
  });

  it("Kestrel's acting tools ask in Manual and run in Auto; web tools run in Read only", () => {
    expect(kind(decide(ask('kestrel_browser_click', ['*']), call('kestrel_browser_click', { ref: 1 }), ctx('ask')))).toBe('card');
    expect(kind(decide(ask('kestrel_browser_click', ['*']), call('kestrel_browser_click', { ref: 1 }), ctx('auto')))).toBe('once');
    expect(kind(decide(ask('webfetch', ['https://x']), undefined, ctx('readonly')))).toBe('once');
  });

  it('a repeated call (doom loop) asks unless Bypass', () => {
    expect(kind(decide(ask('doom_loop', ['*']), undefined, ctx('auto')))).toBe('card');
    expect(kind(decide(ask('doom_loop', ['*']), undefined, ctx('bypass')))).toBe('once');
  });
});

describe('sessionRules', () => {
  it('Read only denies edits, commands and the acting Kestrel tools; Plan denies edits; the rest add nothing', () => {
    const readonly = sessionRules('readonly');
    expect(readonly).toEqual(expect.arrayContaining([{ permission: 'edit', pattern: '*', action: 'deny' }, { permission: 'bash', pattern: '*', action: 'deny' }, { permission: 'kestrel_sim_tap', pattern: '*', action: 'deny' }]));
    expect(readonly.some((r) => r.permission === 'kestrel_browser_read')).toBe(false);
    expect(sessionRules('plan')).toEqual([{ permission: 'edit', pattern: '*', action: 'deny' }]);
    for (const level of ['ask', 'edits', 'auto', 'bypass'] as const) expect(sessionRules(level)).toEqual([]);
  });

  it('Plan runs OpenCode’s plan agent', () => {
    expect(opencodePolicy('plan').agent).toBe('plan');
    expect(opencodePolicy('auto').agent).toBe('build');
  });
});
