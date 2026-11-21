import { describe, expect, it } from 'vitest';
import { KESTREL_TOOLS } from './agents/types.ts';
import { DEFAULT_LIMITS, DELEGATION_LIMITS_KEY, DelegationLimitsPrefs, limitMessage } from './limits.ts';
import { delegationLimitsRoute } from './limits-api.ts';
import { memorySettings } from './suggestions/prefs.ts';
import { matchProject } from './shared/projects.ts';

const counted = () => {
  const inner = memorySettings();
  let reads = 0;
  return { reads: () => reads, store: { getSetting: (key: string) => (reads++, inner.getSetting(key)), putSetting: inner.putSetting } };
};

describe('limit messages', () => {
  it('refuse in plain words an agent can act on, stating the number in force', () => {
    expect(limitMessage.tooManyTasks(DEFAULT_LIMITS, 7)).toMatch(/at most 5 tasks; got 7/);
    expect(limitMessage.tooDeep(DEFAULT_LIMITS)).toMatch(/at most 2 levels deep/);
    expect(limitMessage.tooDeep({ ...DEFAULT_LIMITS, maxDepth: 1 })).toMatch(/at most 1 level deep/);
    expect(limitMessage.tooManyLive({ ...DEFAULT_LIMITS, maxLiveSessionsPerTree: 12 }, 12)).toMatch(/at most 12 live sessions; this one has 12/);
    expect(limitMessage.noTasks()).toMatch(/at least one task/);
  });
});

describe('the delegation limits setting', () => {
  it('is the defaults when nothing is stored, and is read from the store once', async () => {
    const { store, reads } = counted();
    const prefs = new DelegationLimitsPrefs({ settings: store });
    expect(await prefs.current()).toEqual(DEFAULT_LIMITS);
    await prefs.current();
    expect(reads()).toBe(1);
  });
  it('keeps what the user sets, across a new instance on the same store', async () => {
    const { store } = counted();
    await new DelegationLimitsPrefs({ settings: store }).set({ maxChildrenPerDelegate: 8, maxDepth: 3, maxLiveSessionsPerTree: 20 });
    expect(await new DelegationLimitsPrefs({ settings: store }).current()).toEqual({ maxChildrenPerDelegate: 8, maxDepth: 3, maxLiveSessionsPerTree: 20 });
  });
  it('refuses a value outside its range with the reason, and keeps what it had', async () => {
    const prefs = new DelegationLimitsPrefs();
    await expect(prefs.set({ maxChildrenPerDelegate: 5, maxDepth: 9, maxLiveSessionsPerTree: 10 })).rejects.toThrow(/from 1 to 4; 9 is outside/);
    expect(await prefs.current()).toEqual(DEFAULT_LIMITS);
  });
  it('goes back to the defaults on reset, keeping nothing', async () => {
    const { store } = counted();
    const prefs = new DelegationLimitsPrefs({ settings: store });
    await prefs.set({ maxChildrenPerDelegate: 1, maxDepth: 1, maxLiveSessionsPerTree: 1 });
    expect((await prefs.reset()).limits).toEqual(DEFAULT_LIMITS);
    expect(await store.getSetting(DELEGATION_LIMITS_KEY)).toBe('{}');
  });
  it('treats an unreadable stored value as the defaults', async () => {
    const { store } = counted();
    await store.putSetting(DELEGATION_LIMITS_KEY, '{not json');
    expect(await new DelegationLimitsPrefs({ settings: store }).current()).toEqual(DEFAULT_LIMITS);
  });
  it('is reached by its route: GET, PUT and DELETE answer the whole view; a bad value is a 400 with the reason', async () => {
    const prefs = new DelegationLimitsPrefs();
    const route = (method: string, body: Record<string, unknown> = {}) => delegationLimitsRoute(['api', 'delegation-limits'], method, async () => body, prefs);
    expect(await route('GET')).toEqual({ status: 200, body: { limits: DEFAULT_LIMITS, defaults: DEFAULT_LIMITS } });
    expect(await route('PUT', { maxChildrenPerDelegate: 2, maxDepth: 2, maxLiveSessionsPerTree: 10 })).toMatchObject({ status: 200, body: { limits: { maxChildrenPerDelegate: 2 } } });
    expect(await route('PUT', { maxChildrenPerDelegate: 11, maxDepth: 2, maxLiveSessionsPerTree: 10 })).toEqual({ status: 400, body: { error: expect.stringMatching(/from 1 to 10; 11 is outside/) } });
    expect(await route('DELETE')).toMatchObject({ status: 200, body: { limits: DEFAULT_LIMITS } });
    expect(await route('POST')).toBeNull();
    expect(await delegationLimitsRoute(['api', 'delegation-limits', 'x'], 'GET', async () => ({}), prefs)).toBeNull();
  });
  it('cannot be changed by an agent: no Kestrel tool names it', () => {
    expect(KESTREL_TOOLS.filter((t) => /limit/i.test(t))).toEqual([]);
  });
});

describe('matchProject', () => {
  const projects = [
    { id: '1', name: 'bellbird', folders: [{ id: 'f1', path: '/p/bellbird', isGit: true }] },
    { id: '2', name: 'Docs', folders: [{ id: 'f2', path: '/p/docs', isGit: false }] },
    { id: '3', name: 'docs', folders: [{ id: 'f3', path: '/q/docs', isGit: true }] },
  ];
  it('matches by exact path or by name in any case', () => {
    expect(matchProject('/p/bellbird', projects)).toEqual({ project: projects[0], folder: projects[0]!.folders[0] });
    expect(matchProject('BELLBIRD', projects)).toEqual({ project: projects[0], folder: projects[0]!.folders[0] });
  });
  it('says when a name is ambiguous and lists the paths', () => {
    expect(matchProject('docs', projects)).toEqual({ error: expect.stringMatching(/more than one project.*\/p\/docs.*\/q\/docs/) });
  });
  it('lists the valid projects for an unknown or empty name', () => {
    expect(matchProject('nope', projects)).toEqual({ error: expect.stringMatching(/No registered project "nope"\. Valid projects: bellbird \(\/p\/bellbird\); Docs/) });
    expect(matchProject(' ', projects)).toEqual({ error: expect.stringMatching(/A project is required/) });
    expect(matchProject('x', [])).toEqual({ error: expect.stringMatching(/none are registered/) });
  });
});
