// The model presets and roles line (onboarding.md 19): what the record carries, the line, the section's
// button, and Run through the same store as Settings → Models & roles.
import { describe, expect, it } from 'vitest';
import { setupActLabel, setupListOf, type SetupList } from '../shared/setup-list.ts';
import { sectionActLabel } from '../shared/setup-sections.ts';
import { asSetupRecord, MAX_MODELS_JSON, modelsOf, SETUP_RECORD_VERSION, type SetupRecord } from '../shared/setup-record.ts';
import { cleanWhoDoesWhat, NOBODY, rowList, type ModelPreset, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { WhoDoesWhatPrefs } from '../who-does-what/prefs.ts';
import { agentStepRefusal, sectionPlan, type StepContext } from './steps.ts';
import { modelsStep } from './models-step.ts';
import type { ExecuteDeps } from './execute.ts';

const preset = (id: string, name: string, extra: Partial<ModelPreset> = {}): ModelPreset => ({ id, name, agent: 'claude', model: 'opus', effort: 'high', fast: false, ...extra });
const who = (value: Partial<WhoDoesWhat>): WhoDoesWhat => cleanWhoDoesWhat({ ...NOBODY, ...value }, () => 'x');
const rec = (id: string, name: string, extra: Partial<SetupRecord> = {}): SetupRecord => ({ v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac' }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra });

const theirs = who({ presets: [preset('o1', 'Everyday'), preset('o2', 'Review', { agent: 'codex', model: 'gpt-6' })], roles: { design: null, build: 'o1', review: 'o2' }, reviewers: ['o2'], instruction: 'Codex reviews.' });
const laptop = rec('a', 'MacBook Pro', { models: modelsOf(theirs) });
const mini = rec('b', 'Mac mini', { agents: [{ agent: 'claude', state: 'ready' }, { agent: 'codex', state: 'missing' }] });
const line = (list: SetupList) => list.lines.find((l) => l.id === 'models:a');
// A key-shaped value, built in two pieces so the public-tree check does not take this file for a leak.
const KEY = 'ghp' + '_Secret0000000000000000000000000042';

describe('the record’s models part', () => {
  it('is absent with no preset, and leaves out a note or a preset with a key in it', () => {
    expect(modelsOf(NOBODY)).toBeNull();
    expect(modelsOf(undefined)).toBeNull();
    const keyed = modelsOf({ ...theirs, instruction: `Use ${KEY} for reviews.`, presets: [...theirs.presets, preset('o3', 'Leaky', { model: KEY })] })!;
    expect(keyed.instructionLeftOut).toBe(true);
    expect(keyed.who.instruction).toBe('');
    expect(keyed.who.presets.map((p) => p.name)).toEqual(['Everyday', 'Review']);
    expect(JSON.stringify(keyed)).not.toContain(KEY);
  });

  it('is read back only through the same checks, and not at all past its size', () => {
    const raw = JSON.parse(JSON.stringify({ ...laptop, models: { who: { ...theirs, instruction: `token = ${KEY}`, presets: [...theirs.presets, { id: '', name: 'No id', agent: 'claude', model: '', effort: '', fast: false }, { id: 'z', name: 'Bad agent', agent: 'nobody', model: '', effort: '', fast: false }] }, instructionLeftOut: false } }));
    const read = asSetupRecord(raw)!;
    expect(read.models!.who.presets.map((p) => p.name)).toEqual(['Everyday', 'Review']);
    expect(read.models!.instructionLeftOut).toBe(true);
    expect(JSON.stringify(read)).not.toContain(KEY);
    expect(asSetupRecord({ ...raw, models: { who: { ...theirs, instruction: 'x'.repeat(MAX_MODELS_JSON) } } })!.models).toBeNull();
    // An older record has none.
    expect(asSetupRecord(JSON.parse(JSON.stringify(rec('a', 'Old'))))!.models).toBeNull();
  });
});

describe('the model presets and roles line', () => {
  it('says what Run adds, in the Kestrel section, and that Codex is not ready here', () => {
    const list = setupListOf(mini, [laptop], { tool: () => false });
    expect(line(list)).toMatchObject({ group: 'kestrel', kind: 'bring', title: 'Model presets and roles', done: false, page: '#/settings/presets', askAgent: false, from: ['MacBook Pro'] });
    expect(line(list)!.does).toBe('Adds 2 presets this computer lacks ("Everyday" and "Review"), sets Build and Review where none is set here, and copies the note on who does what, as Settings → Models & roles would. Nothing here is replaced. Codex is not ready here yet; until then, a role on its presets goes to its next choice.');
    expect(setupActLabel(line(list)!)).toBe('Copy from MacBook Pro');
    expect(sectionActLabel('kestrel', ['MacBook Pro'])).toBe('Copy from MacBook Pro');
  });

  it('is done when this computer already has every preset and role, and absent when the other has no preset', () => {
    const here = who({ presets: [preset('h1', 'Everyday'), preset('h2', 'Review', { agent: 'codex', model: 'gpt-6' })], roles: { design: null, build: 'h1', review: 'h2' }, reviewers: ['h2'], instruction: 'Mine.' });
    const done = line(setupListOf(mini, [laptop], { tool: () => false, whoDoesWhat: here }))!;
    expect(done.done).toBe(true);
    expect(done.does).toBe("This computer already has MacBook Pro's presets and roles.");
    // This computer's own record stands in when the live setting was not read.
    expect(line(setupListOf({ ...mini, models: modelsOf(here) }, [laptop], { tool: () => false }))!.done).toBe(true);
    expect(line(setupListOf(mini, [rec('a', 'MacBook Pro')], { tool: () => false }))).toBeUndefined();
  });

  it('says when the note was left out for a key', () => {
    const list = setupListOf(mini, [rec('a', 'MacBook Pro', { models: modelsOf({ ...theirs, instruction: `Use ${KEY}.` }) })], { tool: () => false });
    expect(line(list)!.does).toContain('The note on who does what is not brought: something in it looks like a key.');
  });

  it('runs from the section’s button, and never from an agent', () => {
    const list = setupListOf(mini, [laptop], { tool: () => false });
    expect(sectionPlan('kestrel', list).order.map((l) => l.id)).toEqual(['models:a']);
    expect(agentStepRefusal(line(list), list)).toContain('only the person does');
  });
});

describe('Run', () => {
  const ctx = (list: SetupList): StepContext => ({ line: line(list)!, list, input: {}, output: () => undefined, say: () => undefined, files: async () => null });
  const deps = (prefs: WhoDoesWhatPrefs | null): ExecuteDeps => ({ home: '/home/me', platform: 'mac', run: async () => ({ code: 0, problem: null }), fs: {} as ExecuteDeps['fs'], host: () => ({}) as ReturnType<ExecuteDeps['host']>, dataDir: '/data', ...(prefs ? { models: prefs } : {}) });
  const list = setupListOf(mini, [laptop], { tool: () => false });
  const action = line(list)!.action as Extract<NonNullable<ReturnType<typeof line>>['action'], { kind: 'models' }>;

  it('merges into the stored setting, tells its listeners, and Undo puts back what was here', async () => {
    const prefs = new WhoDoesWhatPrefs();
    await prefs.set({ ...NOBODY, presets: [preset('mine', 'Mine', { agent: 'opencode' })], roles: { design: 'mine', build: null, review: null } });
    let told = 0;
    prefs.onChange(() => told++);
    const before = await prefs.current();
    const result = await modelsStep(deps(prefs), ctx(list), action);
    expect(result).toMatchObject({ state: 'done', said: 'Added 2 presets ("Everyday" and "Review"), set Build and Review, and copied the note on who does what.' });
    const after = await prefs.current();
    expect(after.presets.map((p) => p.name)).toEqual(['Mine', 'Everyday', 'Review']);
    expect(after.presets[1]!.id).not.toBe('o1');
    expect(rowList(after, 'design')).toEqual(['mine']);
    expect(rowList(after, 'build')).toEqual([after.presets[1]!.id]);
    expect(told).toBe(1);
    await (result as { undo: () => Promise<void> }).undo();
    expect(await prefs.current()).toEqual(before);
  });

  it('changes nothing when there is nothing to bring, and says why it cannot run in a copy without the setting', async () => {
    const prefs = new WhoDoesWhatPrefs();
    await modelsStep(deps(prefs), ctx(list), action);
    let told = 0;
    prefs.onChange(() => told++);
    expect(await modelsStep(deps(prefs), ctx(list), action)).toEqual({ state: 'done', said: 'Nothing was missing here.' });
    expect(told).toBe(0);
    expect(await modelsStep(deps(null), ctx(list), action)).toMatchObject({ state: 'failed', reason: expect.stringContaining('Settings → Models & roles') });
  });
});
