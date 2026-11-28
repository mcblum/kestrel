// The closed list of a worker node's settings another computer may change (worker-nodes.md section 10).
import { describe, expect, test } from 'vitest';
import { asNodeSettings, autoReviewsOf, FOLLOW_LABEL, isNodeSettingKey, MIRROR_MODE_LABEL, NODE_SETTING_KEYS, NODE_SETTINGS, nodeSettingRefusal, nodeStartModeOf, PUSH_LABEL, restartBusy, reviewModeFor, withNodeStart, type NodeHas, type NodeSettingsValues } from './node-settings.ts';
import { startControls, type Remembered } from './sticky-controls.ts';
import { DEFAULT_NODE_PROJECT_PREFS, sanitizeNodeProjectPrefs } from './node-push.ts';

const has: NodeHas = { here: 'Worker node 1', agents: ['claude', 'codex'], agent: 'claude', models: (agent) => (agent === 'claude' ? ['sonnet', 'opus'] : null) };

const settings: NodeSettingsValues = { name: 'Worker node 1', remoteStarts: true, agent: 'claude', model: '', mode: 'ask', autoReviews: false, projects: 'every', push: true, followDesktopVersion: true };

describe('NODE_SETTINGS', () => {
  test('is exactly the list the design decided, and nothing else', () => {
    expect(NODE_SETTING_KEYS).toEqual(['name', 'remoteStarts', 'agent', 'model', 'mode', 'autoReviews', 'projects', 'push', 'followDesktopVersion']);
    expect(isNodeSettingKey('crashReports')).toBe(false);
    expect(isNodeSettingKey('toString')).toBe(false);
  });

  test('the three settings a node stored on its own keep their words', () => {
    expect(NODE_SETTINGS.push.label).toBe(PUSH_LABEL);
    expect(NODE_SETTINGS.followDesktopVersion.label).toBe(FOLLOW_LABEL);
    expect(MIRROR_MODE_LABEL.every).toBe('Clone every project of the account');
  });

  test('values stored before the list existed are read as they were', () => {
    expect(sanitizeNodeProjectPrefs({ projects: 'on-start', push: false })).toEqual({ projects: 'on-start', push: false });
    expect(sanitizeNodeProjectPrefs(null)).toEqual(DEFAULT_NODE_PROJECT_PREFS);
  });
});

describe('nodeSettingRefusal', () => {
  test('refuses a key not on the list, naming it', () => {
    expect(nodeSettingRefusal('sandboxAllow', true)).toBe('"sandboxAllow" is not a setting another computer may change on a worker node.');
    expect(nodeSettingRefusal(undefined, true)).toContain('is not a setting');
  });

  test('switches take true or false only', () => {
    for (const key of ['remoteStarts', 'autoReviews', 'push', 'followDesktopVersion'] as const) {
      expect(nodeSettingRefusal(key, true)).toBeNull();
      expect(nodeSettingRefusal(key, 'yes')).toContain('give true or false');
    }
  });

  test('a name is a device name', () => {
    expect(nodeSettingRefusal('name', 'Build box')).toBeNull();
    expect(nodeSettingRefusal('name', '   ')).toBe('A worker node needs a name.');
    expect(nodeSettingRefusal('name', 'x'.repeat(65))).toContain('at most 64');
    expect(nodeSettingRefusal('name', 'a\u0001b')).toContain('control characters');
    expect(nodeSettingRefusal('name', 3)).toContain('text');
  });

  test('the mode is Manual or Auto, never Bypass', () => {
    expect(nodeSettingRefusal('mode', 'ask')).toBeNull();
    expect(nodeSettingRefusal('mode', 'auto')).toBeNull();
    expect(nodeSettingRefusal('mode', 'bypass')).toBe('New sessions on a worker node start in Manual or Auto, never Bypass.');
    expect(nodeSettingRefusal('mode', 'plan')).toContain('Manual');
  });

  test('projects is one of the two choices', () => {
    expect(nodeSettingRefusal('projects', 'on-start')).toBeNull();
    expect(nodeSettingRefusal('projects', 'some')).toContain('every, on-start');
  });

  test('the agent must be one the node has, checked on the node', () => {
    expect(nodeSettingRefusal('agent', 'opencode')).toBeNull();
    expect(nodeSettingRefusal('agent', 'opencode', has)).toBe('OpenCode is not on Worker node 1.');
    expect(nodeSettingRefusal('agent', 'gpt', has)).toContain('claude, codex, opencode');
  });

  test("the model must be one of the agent's there; its default always may", () => {
    expect(nodeSettingRefusal('model', 'whatever')).toBeNull();
    expect(nodeSettingRefusal('model', 'opus', has)).toBeNull();
    expect(nodeSettingRefusal('model', '', has)).toBeNull();
    expect(nodeSettingRefusal('model', 'gpt-5', has)).toBe('gpt-5 is not one of the models Claude Code offers on Worker node 1. Pick another.');
    expect(nodeSettingRefusal('model', 'o3', { ...has, agent: 'codex' })).toContain('Codex');
    expect(nodeSettingRefusal('model', 'x'.repeat(301))).toContain('at most 300');
  });
});

describe('the settings a node shares with every computer', () => {
  test('start reviews on its own is the Code reviews mode', () => {
    expect(autoReviewsOf('list')).toBe(false);
    expect(autoReviewsOf('off')).toBe(false);
    expect(autoReviewsOf('start')).toBe(true);
    expect(autoReviewsOf('reply')).toBe(true);
    expect(reviewModeFor(true, 'list')).toBe('start');
    expect(reviewModeFor(true, 'off')).toBe('start');
    expect(reviewModeFor(false, 'start')).toBe('list');
    expect(reviewModeFor(false, 'reply')).toBe('list');
    // Already so: unchanged, and "reply" (which posts in the user's name) is never chosen from here.
    expect(reviewModeFor(true, 'reply')).toBe('reply');
    expect(reviewModeFor(false, 'off')).toBe('off');
  });

  test('the New session mode reads Auto as Auto and anything else as Manual', () => {
    expect(nodeStartModeOf('auto')).toBe('auto');
    expect(nodeStartModeOf('edits')).toBe('ask');
  });
});

describe('asNodeSettings', () => {
  test('reads a whole record and nothing less', () => {
    expect(asNodeSettings(settings)).toEqual(settings);
    expect(asNodeSettings({ ...settings, extra: 1 })).toEqual(settings);
    expect(asNodeSettings({ ...settings, mode: 'bypass' })).toBeNull();
    const { push: _push, ...partial } = settings;
    expect(asNodeSettings(partial)).toBeNull();
    expect(asNodeSettings([])).toBeNull();
  });
});

test('a restart refused for running turns names them', () => {
  expect(restartBusy('Worker node 1', ['Fix login'])).toBe('Worker node 1 has a turn running in “Fix login”. Restart it when that turn ends, or stop it first.');
  expect(restartBusy('Worker node 1', ['A', 'B'])).toContain('turns running in “A”, “B”');
});

describe('withNodeStart', () => {
  const base: Remembered = { agent: 'claude', projectId: 'p1', byAgent: { claude: { model: 'sonnet', effort: 'high', fast: false, permission: 'ask' }, codex: { model: 'o3', effort: '', fast: false, permission: 'auto' } } };
  const opus = [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium'] }];

  test('the agent is the one new sessions start on, with its own last picks', () => {
    const r = withNodeStart(base, { key: 'agent', value: 'codex' });
    expect(startControls(r)).toMatchObject({ agent: 'codex', model: 'o3', permission: 'auto', projectId: 'p1' });
  });

  test("the model is picked on the box's agent, its effort fitted to it", () => {
    const r = withNodeStart(base, { key: 'model', value: 'opus' }, opus);
    expect(startControls(r)).toMatchObject({ agent: 'claude', model: 'opus', effort: '' });
    expect(r.byAgent.codex).toEqual(base.byAgent.codex);
  });

  test("the mode is picked on the box's agent", () => {
    expect(startControls(withNodeStart(base, { key: 'mode', value: 'auto' })).permission).toBe('auto');
  });

  test('with "Always this", the fixed start changes too', () => {
    const fixed: Remembered = { ...base, startFrom: 'fixed', fixed: { agent: 'claude', model: 'sonnet', effort: 'high', fast: false, projectId: null } };
    expect(startControls(withNodeStart(fixed, { key: 'model', value: 'opus' }, opus))).toMatchObject({ agent: 'claude', model: 'opus' });
    expect(startControls(withNodeStart(fixed, { key: 'agent', value: 'codex' }))).toMatchObject({ agent: 'codex', model: 'o3', projectId: null });
  });
});
