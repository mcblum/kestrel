import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import { BYPASS_FROM_ELSEWHERE } from './connect-ops.ts';
import { ASKING, asStartChoices, cannotStartOn, cloneOn, computerOptions, computersOf, defaultComputer, doesNotHave, modelOptionsOf, notThereYet, projectAfterSwitch, projectOn, projectsOn, remoteMode, remoteRunningModes, remoteRunningNote, startingOn, startMayHaveHappened, statusOf, type ComputerStatus } from './start-computer.ts';
import type { RemoteStartChoices } from '../remote-starts/session-start.ts';

const MINI = { id: 'mini', name: 'Mac mini' };
const STUDIO = { id: 'studio', name: 'Studio' };
const choices = (over: Partial<RemoteStartChoices> = {}): RemoteStartChoices => ({
  here: 'Mac mini',
  allowed: true,
  agents: ['claude'],
  presets: [],
  start: { agent: 'claude', model: '', effort: '', fast: false, permission: 'ask' },
  projects: [],
  providers: [{ agent: 'claude', name: 'Claude', models: [{ id: '', name: 'Default' }], default: '' }],
  missing: [],
  ...over,
});
const ready = (over: Partial<RemoteStartChoices> = {}): ComputerStatus => ({ state: 'ready', choices: choices(over) });

const both: Project = { id: 'shop', name: 'Shop', folders: [], alsoOn: [{ ...MINI, projectId: 'shop-there' }] };
const mineOnly: Project = { id: 'docs', name: 'Docs', folders: [] };
const away: Project = { id: 'account|x/billing', name: 'Billing', folders: [], away: true, elsewhere: { machines: [{ ...STUDIO, projectId: 'b-studio' }, { ...MINI, projectId: 'b-mini' }], repos: ['x/billing'], folders: [] } };
const PROJECTS = [both, mineOnly, away];

describe('the computer menu', () => {
  it('lists this computer first, then the others by name, each disabled with its reason', () => {
    const status = (id: string): ComputerStatus => (id === 'mini' ? ready({ allowed: false, refusal: 'Starting sessions on Mac mini from other devices is off in its Settings.' }) : { state: 'unreachable', reason: 'Studio cannot be reached now.' });
    expect(computerOptions('This Mac', [STUDIO, MINI], status)).toEqual([
      { id: null, name: 'This Mac', disabled: null },
      { id: 'mini', name: 'Mac mini', disabled: 'Starting sessions on Mac mini from other devices is off in its Settings.' },
      { id: 'studio', name: 'Studio', disabled: 'Studio cannot be reached now.' },
    ]);
  });

  it('lets no computer be chosen while it has not answered', () => {
    expect(computerOptions('This Mac', [MINI], () => ({ state: 'asking' }))).toEqual([
      { id: null, name: 'This Mac', disabled: null },
      { id: 'mini', name: 'Mac mini', disabled: ASKING },
    ]);
  });

  it('takes a computer that answered and allows starts, and one still being asked', () => {
    expect(cannotStartOn('Mac mini', ready())).toBeNull();
    expect(cannotStartOn('Mac mini', { state: 'asking' })).toBeNull();
    expect(cannotStartOn('Mac mini', statusOf(null))).toBeNull();
  });

  it('refuses one where no agent can start, with that computer’s reason', () => {
    expect(cannotStartOn('Mac mini', ready({ providers: [], missing: [{ agent: 'claude', name: 'Claude', reason: 'Claude is not signed in on Mac mini.' }] }))).toBe('Claude is not signed in on Mac mini.');
    // An older computer lists no agents at all: it starts what its own box would.
    expect(cannotStartOn('Mac mini', ready({ providers: [], missing: [] }))).toBeNull();
  });
});

describe('projects on each computer', () => {
  it('knows a project’s id on each computer that has it', () => {
    expect(projectOn(both, null)).toBe('shop');
    expect(projectOn(both, 'mini')).toBe('shop-there');
    expect(projectOn(mineOnly, 'mini')).toBeUndefined();
    expect(projectOn(away, null)).toBeUndefined();
    expect(projectOn(away, 'mini')).toBe('b-mini');
    expect(computersOf(away)).toEqual(['studio', 'mini']);
  });

  it('offers a computer’s projects only', () => {
    expect(projectsOn(PROJECTS, null).map((p) => p.id)).toEqual(['shop', 'docs']);
    expect(projectsOn(PROJECTS, 'mini').map((p) => p.id)).toEqual(['shop', 'account|x/billing']);
  });

  it('keeps the project when switching to a computer that has it too, and drops it otherwise', () => {
    expect(projectAfterSwitch(PROJECTS, 'shop', 'mini')).toBe('shop');
    expect(projectAfterSwitch(PROJECTS, 'docs', 'mini')).toBeNull();
    expect(projectAfterSwitch(PROJECTS, 'account|x/billing', null)).toBeNull();
    expect(projectAfterSwitch(PROJECTS, null, 'mini')).toBeNull();
  });

  it('opens on this computer when it has the project, else the first other computer that has it and can take it', () => {
    expect(defaultComputer(both)).toBeNull();
    expect(defaultComputer(null)).toBeNull();
    expect(defaultComputer(away)).toBe('studio');
    expect(defaultComputer(away, (id) => (id === 'studio' ? { state: 'unreachable', reason: 'away' } : ready()))).toBe('mini');
  });
});

describe('the mode a session on another computer starts in', () => {
  it('is Manual or Auto, and Bypass becomes Auto with the reason', () => {
    expect(remoteMode('ask', 'Mac mini')).toEqual({ mode: 'ask', note: null });
    expect(remoteMode('auto', 'Mac mini')).toEqual({ mode: 'auto', note: null });
    expect(remoteMode('bypass', 'Mac mini')).toEqual({ mode: 'auto', note: `${BYPASS_FROM_ELSEWHERE} This session starts in Auto on Mac mini.` });
    expect(remoteMode('plan', 'Mac mini').mode).toBe('ask');
  });
});

describe('reading what another computer offers', () => {
  it('keeps what it can read and drops the rest', () => {
    const read = asStartChoices({ here: 'Mac mini', allowed: true, agents: ['claude', 'nope'], start: { agent: 'claude', model: 'opus', permission: 'bypass' }, providers: [{ agent: 'codex', name: 'Codex', models: [{ id: 'gpt', name: 'GPT' }, { name: 'no id' }], default: 'gone' }, { agent: 'other' }], missing: [{ agent: 'opencode', name: 'OpenCode', reason: 'Not installed.' }] });
    expect(read).toMatchObject({ allowed: true, agents: ['claude'], start: { agent: 'claude', model: 'opus', permission: 'ask' }, providers: [{ agent: 'codex', models: [{ id: 'gpt', name: 'GPT' }], default: 'gpt' }], missing: [{ agent: 'opencode', reason: 'Not installed.' }] });
    expect(asStartChoices({ allowed: 'yes' })).toBeNull();
    expect(asStartChoices(null)).toBeNull();
  });

  it('offers Manual and Auto for a running session there, and keeps its own mode shown when it is neither', () => {
    expect(remoteRunningModes('ask')).toEqual(['ask', 'auto']);
    expect(remoteRunningModes('bypass')).toEqual(['ask', 'auto', 'bypass']);
    expect(remoteRunningNote('bypass', 'Mac mini')).toContain('Bypass on Mac mini. Bypass is chosen on the computer the session runs on.');
    expect(remoteRunningNote('auto', 'Mac mini')).toContain('on Mac mini');
  });

  it('reads a published model menu as the model picker does, effort and fast mode included', () => {
    expect(modelOptionsOf([{ id: '', name: 'Default', efforts: ['low', 'high'], fast: true }, { id: 'haiku', name: 'Haiku', more: true }])).toEqual([
      { id: '', label: 'Default', efforts: ['low', 'high'], fast: true },
      { id: 'haiku', label: 'Haiku' },
    ]);
  });
});

describe('a project the computer chosen would clone (item 64)', () => {
  const nodeOffers = { projects: [{ id: 'b-studio', name: 'Billing', folders: [], defaultFolderId: null, clone: { of: ['b-studio', 'b-mini'] } }] };

  it('finds the clone offer by any of the project’s ids elsewhere, and none without offers', () => {
    expect(cloneOn(away, nodeOffers)?.id).toBe('b-studio');
    expect(cloneOn(mineOnly, nodeOffers)).toBeUndefined();
    expect(cloneOn(away, null)).toBeUndefined();
    expect(cloneOn(away, { projects: [{ id: 'b-studio', name: 'Billing', folders: [], defaultFolderId: null }] })).toBeUndefined();
  });

  it('lists what the node has and what it would clone, and keeps a clonable project when switching to it', () => {
    const node = 'node-1';
    expect(projectsOn(PROJECTS, node).map((p) => p.id)).toEqual([]);
    expect(projectsOn(PROJECTS, node, nodeOffers).map((p) => p.id)).toEqual([away.id]);
    expect(projectAfterSwitch(PROJECTS, away.id, node, nodeOffers)).toBe(away.id);
    expect(projectAfterSwitch(PROJECTS, away.id, node, null)).toBeNull();
  });

  it('says each of its words once', () => {
    expect(doesNotHave('Mac mini', 'Docs')).toBe('Mac mini does not have Docs. Clone it there first, or pick a project it has.');
    expect(notThereYet('Worker node 1')).toBe('Not on Worker node 1 yet; it is cloned when the session starts.');
    expect(startingOn('Worker node 1')).toBe('Starting on Worker node 1…');
    expect(startMayHaveHappened('Worker node 1')).toBe('Worker node 1 did not answer in time. If the session started there it will show in the sidebar.');
  });

  it('reads the clone mark of a live answer, and never an empty reason for an agent that cannot start', () => {
    const read = asStartChoices({ here: 'Worker node 1', allowed: true, agents: ['claude'], start: { agent: 'claude' }, missing: [{ agent: 'codex', name: 'Codex', reason: '  ' }], projects: [{ id: 'b', name: 'Billing', folders: [], clone: { of: ['b', 7] } }] });
    expect(read!.projects).toEqual([{ id: 'b', name: 'Billing', folders: [], defaultFolderId: null, clone: { of: ['b'] } }]);
    expect(read!.missing).toEqual([{ agent: 'codex', name: 'Codex', reason: 'Codex cannot start a session on Worker node 1 now.' }]);
  });
});
