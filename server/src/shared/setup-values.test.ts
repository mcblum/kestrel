// What a set-up line's missing values may be copied from, in which words, and what is kept of it (onboarding.md 19).
import { describe, expect, it } from 'vitest';
import { answersCopy, asSentList, checkValuesAnswer, copiedText, copyableNames, copyOfferText, copyOffersOf, copyStepOf, missingNote, olderText, SENT_MAX, sentText, SETUP_ANSWERS, stepText, usableOffer, VALUE_MAX, withSent, type SentEntry } from './setup-values.ts';
import { asSetupRecord, SETUP_RECORD_VERSION, type SetupMcpServer, type SetupRecord } from './setup-record.ts';

function rec(id: string, name: string, extra: Partial<SetupRecord> = {}, answers: readonly string[] | null = SETUP_ANSWERS): SetupRecord {
  return { v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac', ...(answers ? { answers } : {}) }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra };
}

const ha: SetupMcpServer = { name: 'home-assistant', scope: 'user', transport: 'stdio', command: 'uvx', args: ['ha-mcp'], url: null, env: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], headers: [], blanks: [{ kind: 'env', name: 'HOMEASSISTANT_URL' }, { kind: 'env', name: 'HOMEASSISTANT_TOKEN' }], appProgram: null };
const jira: SetupMcpServer = { name: 'jira', scope: 'user', transport: 'http', command: null, args: [], url: 'https://jira.example.com/mcp', env: [], headers: ['Authorization'], blanks: [{ kind: 'header', name: 'Authorization' }], appProgram: null };
const flagged: SetupMcpServer = { ...ha, name: 'flagged', args: ['--token', null], blanks: [{ kind: 'argument', name: '2' }, { kind: 'env', name: 'X' }] };
const settings = { agent: 'claude' as const, kind: 'settings' as const, path: '~/.claude/settings.json', files: 1, keyAt: null, env: ['ANTHROPIC_BASE_URL', 'MY_TOKEN'], plugins: [] };
const laptop = rec('a', 'MacBook Pro', { readAt: 5, mcp: [ha, jira, flagged], files: [settings, { ...settings, agent: 'codex', path: '~/.codex/config.toml' }] });

describe('what may be copied', () => {
  it('names an MCP server or a settings file, and nothing else', () => {
    expect(copyStepOf('mcp:home-assistant')).toEqual({ kind: 'mcp', server: 'home-assistant' });
    expect(copyStepOf('file:~/.claude/settings.json')).toEqual({ kind: 'settings', path: '~/.claude/settings.json' });
    for (const id of ['agent:claude', 'host:gh:github.com', 'project:git@x:y.git', 'tool:uv', 'git:signing', 'mcp:', 'file:']) expect(copyStepOf(id)).toBeNull();
  });

  it("takes an MCP server's environment and header names, and a Claude settings file's env names", () => {
    expect(copyableNames(laptop, 'mcp:home-assistant')).toEqual(['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN']);
    expect(copyableNames(laptop, 'mcp:jira')).toEqual(['Authorization']);
    expect(copyableNames(laptop, 'file:~/.claude/settings.json')).toEqual(['ANTHROPIC_BASE_URL', 'MY_TOKEN']);
  });

  it('takes nothing from a server with an argument or address part left out, a Codex file, or a step it does not have', () => {
    expect(copyableNames(laptop, 'mcp:flagged')).toBeNull();
    expect(copyableNames(laptop, 'file:~/.codex/config.toml')).toBeNull();
    expect(copyableNames(laptop, 'mcp:nope')).toBeNull();
    expect(copyableNames(laptop, 'agent:claude')).toBeNull();
    expect(copyableNames({ ...laptop, files: [{ ...settings, keyAt: { path: settings.path, line: 2 } }] }, 'file:~/.claude/settings.json')).toBeNull();
  });
});

describe('who a line may copy from', () => {
  const studio = rec('c', 'Studio iMac', { readAt: 2, mcp: [{ ...ha, env: ['HOMEASSISTANT_URL'], blanks: [{ kind: 'env', name: 'HOMEASSISTANT_URL' }] }] });
  const old = rec('d', 'Old Mac', { readAt: 9, mcp: [ha] }, null);

  it('offers every computer that has a missing name, the most recently read first, with which names', () => {
    const copy = copyOffersOf('mcp:home-assistant', [studio, laptop, old], 'all')!;
    expect(copy.missing).toEqual(['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN']);
    expect(copy.offers.map((o) => [o.name, o.names, o.older])).toEqual([
      ['Old Mac', ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], true],
      ['MacBook Pro', ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], false],
      ['Studio iMac', ['HOMEASSISTANT_URL'], false],
    ]);
    expect(usableOffer(copy)?.name).toBe('MacBook Pro');
    expect(copyOfferText(copy.offers[1]!, copy.missing)).toBe('MacBook Pro: all 2');
    expect(copyOfferText(copy.offers[2]!, copy.missing)).toBe('Studio iMac: HOMEASSISTANT_URL only');
  });

  it('asks only for what is missing here, and offers nothing when that is none of theirs', () => {
    expect(copyOffersOf('mcp:home-assistant', [laptop], ['HOMEASSISTANT_TOKEN'])!.offers[0]!.names).toEqual(['HOMEASSISTANT_TOKEN']);
    expect(copyOffersOf('mcp:home-assistant', [laptop], [])).toBeNull();
    expect(copyOffersOf('mcp:home-assistant', [laptop], ['SOMETHING_ELSE'])).toBeNull();
    expect(copyOffersOf('agent:claude', [laptop], 'all')).toBeNull();
    expect(copyOffersOf('mcp:flagged', [laptop], 'all')).toBeNull();
  });

  it('knows an older computer cannot be asked, by its record', () => {
    expect(answersCopy(laptop)).toBe(true);
    expect(answersCopy(old)).toBe(false);
    expect(usableOffer(copyOffersOf('mcp:home-assistant', [old], 'all'))).toBeNull();
    expect(olderText('Old Mac')).toBe('Update Kestrel on Old Mac to copy values from it.');
  });

  it('reads `answers` back from a record, and an older record without it', () => {
    expect(asSetupRecord(laptop)!.machine.answers).toEqual(SETUP_ANSWERS);
    expect(asSetupRecord(old)!.machine.answers).toBeUndefined();
  });
});

describe('the words', () => {
  it('says both ways in the missing row when there is a computer to copy from', () => {
    const copy = copyOffersOf('mcp:home-assistant', [laptop], 'all');
    expect(missingNote(copy, 2)).toBe('Copy them from MacBook Pro, or enter them here.');
    expect(missingNote(null, 1)).toBe('Enter it here.');
  });

  it('names what was copied and sent, never a value', () => {
    expect(copiedText(['A', 'B'], [], 'MacBook Pro', 'home-assistant')).toBe('Copied A and B from MacBook Pro into home-assistant.');
    expect(copiedText(['A'], ['B'], 'MacBook Pro', 'home-assistant')).toBe('Copied A from MacBook Pro into home-assistant. Not on MacBook Pro: B; type it here.');
    expect(sentText(['A', 'B', 'C'], 'Mac mini', 'MCP server x')).toBe('Sent A, B and C to Mac mini, for MCP server x.');
    expect(stepText('mcp:x')).toBe('MCP server x');
    expect(stepText('file:~/.claude/settings.json')).toBe('Claude settings file ~/.claude/settings.json');
  });
});

describe('checking the answer', () => {
  it('takes values and not-there names that cover what was asked', () => {
    expect(checkValuesAnswer(['A', 'B'], { values: { A: 'one' }, notThere: ['B'] })).toEqual({ ok: true, answer: { values: { A: 'one' }, notThere: ['B'] } });
  });

  it('writes nothing for a name not asked for, a value too long or empty, or a name left unanswered, and never quotes a value', () => {
    const stray = checkValuesAnswer(['A'], { values: { A: 'secret-one', B: 'secret-two' }, notThere: [] });
    expect(stray).toMatchObject({ ok: false });
    expect(JSON.stringify(stray)).not.toContain('secret');
    expect(checkValuesAnswer(['A'], { values: { A: 'x'.repeat(VALUE_MAX + 1) }, notThere: [] })).toMatchObject({ ok: false });
    expect(checkValuesAnswer(['A'], { values: { A: '' }, notThere: [] })).toMatchObject({ ok: false });
    expect(checkValuesAnswer(['A', 'B'], { values: { A: 'x' }, notThere: [] })).toMatchObject({ ok: false });
    expect(checkValuesAnswer(['A'], { values: {}, notThere: ['Z'] })).toMatchObject({ ok: false });
    expect(checkValuesAnswer(['A'], null)).toMatchObject({ ok: false });
  });
});

describe('the record of what was sent', () => {
  const entry = (at: number): SentEntry => ({ at, to: { id: 'b', name: 'Mac mini' }, line: 'mcp:x', step: 'MCP server x', names: ['A'], notThere: [] });

  it('keeps the newest first and at most 50', () => {
    let list: SentEntry[] = [];
    for (let i = 0; i < SENT_MAX + 1; i++) list = withSent(list, entry(i));
    expect(list).toHaveLength(SENT_MAX);
    expect(list[0]!.at).toBe(SENT_MAX);
    expect(list.at(-1)!.at).toBe(1);
  });

  it('reads back only the known fields, so nothing else can ride in it', () => {
    expect(asSentList([{ ...entry(1), value: 'sneaky', names: ['A'] }])).toEqual([entry(1)]);
    expect(asSentList([{ ...entry(1), names: ['not a name!'] }, 'junk'])).toEqual([]);
    expect(asSentList(null)).toEqual([]);
  });
});
