// A worker node's settings, changed from another computer's page: each key carried out by the setting's own store, and
// Restart refused while a turn runs. Stand-ins for every store; nothing is restarted.
import { describe, expect, test } from 'vitest';
import { Refused } from '../refused.ts';
import { NodeProjectPrefsStore } from '../project-clone/prefs.ts';
import { RemoteStarts } from '../remote-starts/prefs.ts';
import { ReviewPrefs } from '../review-settings/prefs.ts';
import { NodeUpdateStore } from '../node-update/store.ts';
import { memorySettings } from '../suggestions/prefs.ts';
import { deskStart } from '../remote-starts/session-start.ts';
import type { NodeFacts } from '../shared/node-facts.ts';
import { NodeSettings, RESTART_AFTER_MS, type NodeSettingsDeps } from './service.ts';

const FACTS: NodeFacts = { agents: { claude: 'Can run', codex: 'Can run', opencode: 'Not available.' }, git: 'key made', sandbox: 'Available', lingering: 'On', freeDisk: '9 GB free.', projects: '2 of 2 cloned.' };

function node(over: Partial<NodeSettingsDeps> = {}) {
  const settings = memorySettings();
  let name = 'Worker node 1';
  let ui: string | null = JSON.stringify({ tabs: { tabs: [], activeId: null }, remembered: { agent: 'claude', projectId: null, byAgent: { claude: { model: 'sonnet', effort: 'high', fast: false, permission: 'ask' } } } });
  const restarts: number[] = [];
  const waits: number[] = [];
  const updateStore = new NodeUpdateStore(settings);
  let looked = 0;
  const deps: NodeSettingsDeps = {
    kind: 'node',
    name: () => name,
    rename: async (n) => (name = n),
    remoteStarts: new RemoteStarts({ settings }),
    uiState: { get: async () => ui, set: async (raw) => void (ui = raw) },
    reviews: new ReviewPrefs({ settings }),
    projects: new NodeProjectPrefsStore(settings),
    follow: { current: async () => (await updateStore.current()).follow, set: async (on) => { await updateStore.set({ follow: on }); looked++; } },
    agents: () => ['claude', 'codex'],
    models: async (agent) => (agent === 'claude' ? [{ id: 'sonnet', label: 'Sonnet', efforts: ['high'] }, { id: 'opus', label: 'Opus' }] : []),
    facts: async () => FACTS,
    running: async () => [],
    service: async () => true,
    restartUnit: () => restarts.push(1),
    later: (work, ms) => { waits.push(ms); work(); },
    ...over,
  };
  const s = new NodeSettings(deps);
  return { s, settings, restarts, waits, ui: () => ui, looked: () => looked, updateStore };
}

describe('NodeSettings', () => {
  test('publishes the settings as their own stores hold them, and the facts', async () => {
    const { s } = node();
    expect(await s.published()).toEqual({
      settings: { name: 'Worker node 1', remoteStarts: true, agent: 'claude', model: 'sonnet', mode: 'ask', autoReviews: false, projects: 'every', push: true, followDesktopVersion: true },
      facts: FACTS,
    });
  });

  test('values stored before the list existed are read', async () => {
    const { s, settings } = node();
    await settings.putSetting('node-projects', JSON.stringify({ projects: 'on-start', push: false }));
    await settings.putSetting('node-update', JSON.stringify({ follow: false, failed: null }));
    expect((await s.values())).toMatchObject({ projects: 'on-start', push: false, followDesktopVersion: false });
  });

  test("each key is carried out by the setting's own function", async () => {
    const { s, ui, looked } = node();
    let told = 0;
    s.onChange(() => told++);
    await s.set('name', 'Build box');
    await s.set('remoteStarts', false);
    await s.set('autoReviews', true);
    await s.set('projects', 'on-start');
    await s.set('push', false);
    await s.set('followDesktopVersion', false);
    await s.set('mode', 'auto');
    await s.set('model', 'opus');
    const after = await s.set('agent', 'codex');
    expect(after.settings).toMatchObject({ name: 'Build box', remoteStarts: false, autoReviews: true, projects: 'on-start', push: false, followDesktopVersion: false, agent: 'codex' });
    expect(looked()).toBe(1);
    expect(told).toBeGreaterThanOrEqual(9);
    // The rest of the UI state is kept, and the Claude picks stay Claude's.
    const stored = JSON.parse(ui()!);
    expect(stored.tabs).toEqual({ tabs: [], activeId: null });
    expect(stored.remembered.byAgent.claude).toEqual({ model: 'opus', effort: '', fast: false, permission: 'auto' });
    expect(deskStart(ui()).agent).toBe('codex');
  });

  test('turning automatic reviews off lists them; on starts them', async () => {
    const { s } = node();
    await s.set('autoReviews', true);
    expect((await s.values()).autoReviews).toBe(true);
    await s.set('autoReviews', false);
    expect((await s.values()).autoReviews).toBe(false);
  });

  test('refuses with the reason: a key not on the list, a value out of range, an agent or model it does not have', async () => {
    const { s } = node();
    await expect(s.set('crash' as never, true)).rejects.toThrow(/not a setting another computer may change/);
    await expect(s.set('mode', 'bypass')).rejects.toThrow('never Bypass');
    await expect(s.set('agent', 'opencode')).rejects.toThrow('OpenCode is not on Worker node 1.');
    await expect(s.set('model', 'gpt-5')).rejects.toThrow('gpt-5 is not one of the models Claude Code offers on Worker node 1');
    await expect(s.set('model', 'opus')).resolves.toBeTruthy();
    await expect(s.set('remoteStarts', 'yes')).rejects.toBeInstanceOf(Refused);
  });

  test('a computer that is not a node refuses', async () => {
    const { s } = node({ kind: 'app' });
    await expect(s.set('push', false)).rejects.toThrow('is not a worker node');
    await expect(s.restart()).rejects.toThrow('is not a worker node');
  });
});

describe('Restart', () => {
  test('restarts the unit after answering', async () => {
    const { s, restarts, waits } = node();
    expect(await s.restart()).toEqual({ text: 'Worker node 1 is restarting. It is back in a few seconds.' });
    expect(waits).toEqual([RESTART_AFTER_MS]);
    expect(restarts).toEqual([1]);
  });

  test('is refused while a turn runs, naming the sessions', async () => {
    const { s, restarts } = node({ running: async () => ['Fix login'] });
    await expect(s.restart()).rejects.toThrow('Worker node 1 has a turn running in “Fix login”.');
    expect(restarts).toEqual([]);
  });

  test('is refused where systemd does not run the node', async () => {
    const { s, restarts } = node({ service: async () => false });
    await expect(s.restart()).rejects.toThrow('does not run under its systemd service');
    expect(restarts).toEqual([]);
  });
});
