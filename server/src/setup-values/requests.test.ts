// The answering computer's side of copying set-up values (onboarding.md 19.4 to 19.7, 19.14): every refusal
// reads nothing, Deny and the time running out read nothing, Allow reads exactly the names, and the record of
// what was sent holds names only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Refused } from '../refused.ts';
import { NEVER_REMOTE } from '../shared/connect-ops.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from '../shared/setup-record.ts';
import { SENT_MAX, SETUP_SENT_KEY, type ValuesAnswer } from '../shared/setup-values.ts';
import { memorySettings } from '../suggestions/prefs.ts';
import { ReadFailed } from './read.ts';
import { ValueRequests, type ValueRequestsDeps } from './requests.ts';

const SECRET = 'tok-SECRET-7f3a';

const own: SetupRecord = {
  v: SETUP_RECORD_VERSION,
  kind: 'setup',
  machine: { id: 'laptop', name: 'MacBook Pro', platform: 'mac' },
  readAt: 1,
  agents: [],
  hosts: [],
  git: { name: null, email: null, signs: false, format: null, signingKey: null },
  ssh: { hosts: [], keyFiles: [] },
  mcp: [
    { name: 'home-assistant', scope: 'user', transport: 'stdio', command: 'uvx', args: [], url: null, env: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], headers: [], blanks: [{ kind: 'env', name: 'HOMEASSISTANT_URL' }, { kind: 'env', name: 'HOMEASSISTANT_TOKEN' }], appProgram: null },
    { name: 'flagged', scope: 'user', transport: 'stdio', command: 'x', args: ['--token', null], url: null, env: ['A'], headers: [], blanks: [{ kind: 'argument', name: '2' }, { kind: 'env', name: 'A' }], appProgram: null },
  ],
  files: [{ agent: 'claude', kind: 'settings', path: '~/.claude/settings.json', files: 1, keyAt: null, env: ['MY_TOKEN'], plugins: [] }],
  tools: [],
  projects: [],
  problems: [],
};

const devices: Record<string, { kind: 'desktop' | 'phone'; name: string }> = { mini: { kind: 'desktop', name: 'Mac mini' }, iphone: { kind: 'phone', name: 'iPhone' }, studio: { kind: 'desktop', name: 'Studio' } };

function requests(over: Partial<ValueRequestsDeps> = {}) {
  const read = vi.fn(async (_line: string, names: readonly string[]): Promise<ValuesAnswer> => ({ values: Object.fromEntries(names.filter((n) => n !== 'HOMEASSISTANT_URL').map((n) => [n, SECRET])), notThere: names.filter((n) => n === 'HOMEASSISTANT_URL') }));
  const settings = memorySettings();
  let now = 1_000;
  const deps: ValueRequestsDeps = { ownRecord: async () => own, device: (id) => devices[id] ?? null, read, source: () => 'from ~/.claude.json on this computer', settings, here: () => 'MacBook Pro', now: () => now, ...over };
  return { values: new ValueRequests(deps), read, settings, tick: (ms: number) => (now += ms) };
}

const ask = { requestId: 'r1', line: 'mcp:home-assistant', names: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'] };
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no refusal';
  } catch (error) {
    expect(error).toBeInstanceOf(Refused);
    return (error as Error).message;
  }
};

afterEach(() => vi.useRealTimers());

describe('a request another computer makes', () => {
  it('is refused, having read nothing, for a phone, a device not in the keyring, a step not in this record, another kind, or a name it does not list', async () => {
    const { values, read } = requests();
    expect(await reason(values.ask('iphone', ask))).toBe(NEVER_REMOTE.setup);
    expect(await reason(values.ask('stranger', ask))).toBe(NEVER_REMOTE.setup);
    expect(await reason(values.ask('mini', { ...ask, line: 'mcp:nope' }))).toBe('MacBook Pro has no MCP server called nope.');
    expect(await reason(values.ask('mini', { ...ask, line: 'file:~/.codex/config.toml' }))).toBe('MacBook Pro has no settings file at ~/.codex/config.toml.');
    expect(await reason(values.ask('mini', { ...ask, line: 'mcp:flagged', names: ['A'] }))).toBe('MacBook Pro has no MCP server called flagged.');
    expect(await reason(values.ask('mini', { ...ask, line: 'agent:claude' }))).toMatch(/Only MCP servers’ and Claude settings files’ values can be copied/);
    expect(await reason(values.ask('mini', { ...ask, names: ['HOMEASSISTANT_TOKEN', 'GITHUB_TOKEN'] }))).toBe('MCP server home-assistant on MacBook Pro has no value called GITHUB_TOKEN.');
    expect(await reason(values.ask('mini', { ...ask, line: 'file:~/.claude/settings.json', names: ['permissions'] }))).toMatch(/has no value called permissions/);
    expect(read).not.toHaveBeenCalled();
    expect(values.view()).toEqual([]);
  });

  it('is refused when this computer cannot read its own set-up', async () => {
    const { values } = requests({ ownRecord: async () => Promise.reject(new Error('no account')) });
    expect(await reason(values.ask('mini', ask))).toBe('MacBook Pro has not read its own set-up yet: open Connections there.');
  });

  it('waits on the person here with the names, the asking computer named by the keyring, and no value', async () => {
    const { values, read } = requests();
    const pending = values.ask('mini', ask);
    await vi.waitFor(() => expect(values.view()).toHaveLength(1));
    expect(values.view()[0]).toMatchObject({ from: { id: 'mini', name: 'Mac mini' }, step: 'MCP server home-assistant', names: ask.names, source: 'from ~/.claude.json on this computer', expiresAt: 1_000 + 120_000 });
    expect(read).not.toHaveBeenCalled();
    expect(await reason(values.ask('mini', { ...ask, requestId: 'r2' }))).toBe('MacBook Pro is already asking you about another step from this computer.');
    values.withdraw('mini', 'r1');
    expect(await reason(pending)).toBe('The request was withdrawn.');
  });

  it('Deny sends nothing, reads nothing and records nothing', async () => {
    const { values, read, settings } = requests();
    const pending = values.ask('mini', ask);
    await vi.waitFor(() => expect(values.view()).toHaveLength(1));
    expect(await values.answer(values.view()[0]!.id, false)).toBeNull();
    expect(await reason(pending)).toBe('MacBook Pro said no.');
    expect(read).not.toHaveBeenCalled();
    expect(await settings.getSetting(SETUP_SENT_KEY)).toBeNull();
  });

  it('runs out after two minutes, reading nothing', async () => {
    vi.useFakeTimers();
    const { values, read } = requests();
    const pending = values.ask('mini', ask);
    const refused = reason(pending);
    await vi.waitFor(() => expect(values.view()).toHaveLength(1));
    vi.advanceTimersByTime(120_000);
    expect(await refused).toBe('MacBook Pro did not answer within 2 minutes.');
    expect(values.view()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('goes when the asking computer goes, and when Kestrel closes', async () => {
    const { values } = requests();
    const a = reason(values.ask('mini', ask));
    const b = reason(values.ask('studio', ask));
    await vi.waitFor(() => expect(values.view()).toHaveLength(2));
    values.dropDevice('mini');
    expect(await a).toBe('The request was withdrawn.');
    values.close();
    expect(await b).toBe('The request was withdrawn.');
  });

  it('Allow reads exactly the names, hands the values to the reply, and records names only', async () => {
    const { values, read, settings, tick } = requests();
    const pending = values.ask('mini', ask);
    await vi.waitFor(() => expect(values.view()).toHaveLength(1));
    tick(5);
    const report = await values.answer(values.view()[0]!.id, true);
    expect(report).toEqual({ to: 'Mac mini', step: 'MCP server home-assistant', sent: ['HOMEASSISTANT_TOKEN'], notThere: ['HOMEASSISTANT_URL'] });
    expect(read).toHaveBeenCalledWith('mcp:home-assistant', ask.names, own);
    expect(await pending).toEqual({ values: { HOMEASSISTANT_TOKEN: SECRET }, notThere: ['HOMEASSISTANT_URL'] });
    const stored = (await settings.getSetting(SETUP_SENT_KEY))!;
    expect(stored).not.toContain(SECRET);
    expect(await values.sent()).toEqual([{ at: 1_005, to: { id: 'mini', name: 'Mac mini' }, line: 'mcp:home-assistant', step: 'MCP server home-assistant', names: ['HOMEASSISTANT_TOKEN'], notThere: ['HOMEASSISTANT_URL'] }]);
    expect(await reason(values.answer('gone', true))).toMatch(/no longer waiting/);
  });

  it('a read that fails is said in fixed words, to both computers, with nothing of the file in them', async () => {
    const { values } = requests({ read: async () => Promise.reject(new ReadFailed('~/.claude.json could not be read.')) });
    const pending = reason(values.ask('mini', ask));
    await vi.waitFor(() => expect(values.view()).toHaveLength(1));
    expect(await reason(values.answer(values.view()[0]!.id, true))).toBe('MacBook Pro could not read the values: ~/.claude.json could not be read.');
    expect(await pending).toBe('MacBook Pro could not read the values: ~/.claude.json could not be read.');
    expect(await values.sent()).toEqual([]);
  });
});

describe('the record of what was sent', () => {
  it('keeps the last 50, and Clear has an Undo that puts them back', async () => {
    const { values, settings } = requests();
    const entry = (at: number) => ({ at, to: { id: 'mini', name: 'Mac mini' }, line: 'mcp:x', step: 'MCP server x', names: ['A'], notThere: [] });
    await settings.putSetting(SETUP_SENT_KEY, JSON.stringify(Array.from({ length: SENT_MAX + 5 }, (_, i) => entry(i))));
    expect(await values.sent()).toHaveLength(SENT_MAX);
    const token = await values.clearSent();
    expect(await values.sent()).toEqual([]);
    expect(await values.restoreSent(token)).toHaveLength(SENT_MAX);
    expect(await reason(values.restoreSent(token))).toBe('That can no longer be undone.');
  });
});
