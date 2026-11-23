import { describe, expect, it } from 'vitest';
import { DEFAULT_REMEMBERED, pickBetween, picksModel, rememberPick, rememberSent, startControls, startFromOf, storedRemembered, withFixed, withStartFrom, type Remembered } from './sticky-controls.ts';
import { DEFAULT_CONTROLS, type Controls } from './tabs.ts';

const claude = { model: 'opus', effort: 'high', fast: true, permission: 'auto' as const };
const codex = { model: 'gpt-6-luna', effort: 'low', fast: false, permission: 'edits' as const };
const last: Remembered = { agent: 'claude', projectId: 'p1', byAgent: { claude } };
const both: Remembered = { ...last, byAgent: { claude, codex } };

describe('what a new session starts with', () => {
  it("is the last agent's remembered set, in the last project, in no group", () => {
    expect(startControls(last)).toEqual({ ...DEFAULT_CONTROLS, agent: 'claude', projectId: 'p1', groupId: null, ...claude });
  });

  it('is the same object for the same remembered state, so a selector can return it', () => {
    expect(startControls(last)).toBe(startControls(last));
  });

  it("starts an agent with nothing remembered at its defaults, in the last agent's mode", () => {
    expect(startControls({ ...last, agent: 'codex' })).toMatchObject({ agent: 'codex', model: '', effort: '', fast: false, permission: 'auto' });
    expect(startControls(DEFAULT_REMEMBERED)).toMatchObject({ agent: 'claude', model: '', permission: 'ask' });
  });
});

describe('rememberPick', () => {
  it('remembers the model, effort and fast mode picked by hand, for the agent they were picked on', () => {
    expect(rememberPick(last, { model: 'haiku', agent: 'claude' }).byAgent.claude).toEqual({ ...claude, model: 'haiku' });
    expect(rememberPick(last, { effort: 'low', agent: 'claude' }).byAgent.claude).toEqual({ ...claude, effort: 'low' });
  });

  it("a pick on one agent leaves the other's set alone (matt/kestrel#14)", () => {
    const next = rememberPick(both, { model: 'gpt-6-sol', agent: 'codex' });
    expect(next.byAgent.claude).toBe(claude);
    expect(next.byAgent.codex).toEqual({ ...codex, model: 'gpt-6-sol' });
    expect(next.agent).toBe('codex');
    // And back: Claude's model is still there.
    expect(startControls({ ...next, agent: 'claude' }).model).toBe('opus');
  });

  it('remembers the mode per agent, and never carries Bypass over', () => {
    expect(rememberPick(both, { permission: 'plan', agent: 'codex' }).byAgent).toEqual({ claude, codex: { ...codex, permission: 'plan' } });
    expect(rememberPick(last, { permission: 'bypass', agent: 'claude' }).byAgent.claude!.permission).toBe('auto');
    // A mode alone does not change the agent new sessions start on.
    expect(rememberPick(last, { permission: 'plan', agent: 'codex' }).agent).toBe('claude');
  });

  it('a first pick on an agent starts from its defaults', () => {
    expect(rememberPick(last, { model: 'gpt-6-luna', agent: 'codex' }).byAgent.codex).toEqual({ model: 'gpt-6-luna', effort: '', fast: false, permission: 'auto' });
  });
});

describe('rememberSent', () => {
  it("takes the draft's agent and project and keeps every agent's picks as last picked", () => {
    const sent: Controls = { ...DEFAULT_CONTROLS, agent: 'codex', model: 'gpt-6.2-sol', permission: 'ask', projectId: 'p2' };
    expect(rememberSent(sent, both)).toEqual({ agent: 'codex', projectId: 'p2', byAgent: both.byAgent });
  });

  it('returns the same object when nothing changes', () => {
    expect(rememberSent({ agent: 'claude', projectId: 'p1' }, last)).toBe(last);
  });
});

describe('pickBetween', () => {
  const before: Controls = { ...DEFAULT_CONTROLS, ...claude };

  it('names only the sticky controls that changed, with the agent they were picked on', () => {
    expect(pickBetween(before, { ...before, projectId: 'p2' })).toEqual({});
    expect(pickBetween(before, { ...before, model: 'haiku', effort: '' })).toEqual({ model: 'haiku', effort: '', agent: 'claude' });
    expect(pickBetween({ ...before, fast: undefined }, { ...before, fast: false })).toEqual({});
    expect(pickBetween(before, { ...before, permission: 'plan' })).toEqual({ permission: 'plan', agent: 'claude' });
  });
});

describe('the stored shape', () => {
  it('reads what it writes', () => {
    expect(storedRemembered({ remembered: JSON.parse(JSON.stringify(both)) })).toEqual(both);
  });

  it("turns a store from before 0.0.17 (one lastControls) into that agent's set, once", () => {
    const lastControls = { ...DEFAULT_CONTROLS, agent: 'codex', model: 'gpt-6-luna', effort: 'low', permission: 'bypass', projectId: 'p3', groupId: 'g', folderId: 'f' };
    expect(storedRemembered({ lastControls })).toEqual({ agent: 'codex', projectId: 'p3', byAgent: { codex: { model: 'gpt-6-luna', effort: 'low', fast: false, permission: 'auto' } } });
    // The new shape wins over a leftover old one.
    expect(storedRemembered({ remembered: last, lastControls })).toEqual(last);
  });

  it('drops what it cannot read', () => {
    expect(storedRemembered({})).toEqual(DEFAULT_REMEMBERED);
    expect(storedRemembered({ remembered: { agent: 'nobody' }, lastControls: 'x' })).toEqual(DEFAULT_REMEMBERED);
    expect(storedRemembered({ remembered: { agent: 'codex', byAgent: { nobody: claude, claude: 5, codex: { model: 7, permission: 'yes' } } } })).toEqual({
      agent: 'codex',
      projectId: null,
      byAgent: { codex: { model: '', effort: '', fast: false, permission: 'ask' } },
    });
  });
});

describe('a fixed start for new sessions', () => {
  const last: Remembered = { agent: 'claude', projectId: 'p1', byAgent: { claude: { model: 'opus', effort: 'high', fast: false, permission: 'auto' }, codex: { model: 'gpt', effort: '', fast: false, permission: 'ask' } } };

  it('follows the last used until the user chooses a fixed start, which begins as what they start with now', () => {
    expect(startFromOf(last)).toBe('last');
    const fixed = withStartFrom(last, 'fixed');
    expect(startFromOf(fixed)).toBe('fixed');
    expect(fixed.fixed).toEqual({ agent: 'claude', model: 'opus', effort: 'high', fast: false, projectId: 'p1' });
    expect(startControls(fixed)).toMatchObject({ agent: 'claude', model: 'opus', effort: 'high', permission: 'auto', projectId: 'p1' });
    expect(withStartFrom(fixed, 'fixed')).toBe(fixed);
  });

  it('starts every new session on the fixed agent and model whatever was picked last, with that agent’s last mode', () => {
    const fixed = withFixed(withStartFrom(last, 'fixed'), { agent: 'codex', model: 'gpt-6.2-sol', effort: 'medium', projectId: null });
    expect(startControls(fixed)).toMatchObject({ agent: 'codex', model: 'gpt-6.2-sol', effort: 'medium', fast: false, permission: 'ask' });
    // A later pick in a session is remembered, and does not move the fixed start.
    const picked = rememberPick(fixed, { agent: 'claude', model: 'haiku' });
    expect(startControls(picked)).toMatchObject({ agent: 'codex', model: 'gpt-6.2-sol' });
    // Back on "last used", that pick is what new sessions start with; the fixed start is kept for next time.
    const back = withStartFrom(picked, 'last');
    expect(startControls(back)).toMatchObject({ agent: 'claude', model: 'haiku' });
    expect(startControls(withStartFrom(back, 'fixed'))).toMatchObject({ agent: 'codex', model: 'gpt-6.2-sol' });
  });

  it('keeps the fixed project, no project included, when a session is started somewhere else', () => {
    const fixed = withFixed(withStartFrom(last, 'fixed'), { agent: 'claude', model: 'opus', effort: 'high', projectId: null });
    expect(startControls(fixed).projectId).toBeNull();
    // A session started from a project's own page: remembered as last used, and the fixed start stays.
    const sent = rememberSent({ agent: 'claude', projectId: 'p2' }, fixed);
    expect(startControls(sent).projectId).toBeNull();
    expect(startControls(withStartFrom(sent, 'last')).projectId).toBe('p2');
    // A fixed start stored before it held a project keeps the project remembered then.
    const older = { ...last, startFrom: 'fixed', fixed: { agent: 'claude', model: 'opus', effort: 'high', fast: false } };
    expect(storedRemembered({ remembered: older }).fixed?.projectId).toBe('p1');
  });

  it('is read back from stored state, and an unreadable one is the last used', () => {
    const fixed = withFixed(withStartFrom(last, 'fixed'), { agent: 'codex', model: 'gpt-6.2-sol', effort: 'medium', projectId: null });
    expect(storedRemembered({ remembered: JSON.parse(JSON.stringify(fixed)) })).toEqual(fixed);
    expect(startFromOf(storedRemembered({ remembered: { ...last, startFrom: 'fixed' } }))).toBe('last');
    expect(startFromOf(storedRemembered({ remembered: { ...last, startFrom: 'fixed', fixed: { agent: 'nobody' } } }))).toBe('last');
  });

  it('tells a pick of a model, effort or fast mode from a pick of the mode alone', () => {
    expect(picksModel({ model: 'opus', agent: 'claude' })).toBe(true);
    expect(picksModel({ effort: '', agent: 'claude' })).toBe(true);
    expect(picksModel({ permission: 'auto', agent: 'claude' })).toBe(false);
    expect(picksModel({})).toBe(false);
  });
});

