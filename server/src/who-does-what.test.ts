// Model presets and the "Who does what" table (shared/who-does-what.ts, who-does-what/*).
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLS } from './shared/tabs.ts';
import { applyPreset, cannotRunNow, cleanWhoDoesWhat, nextRunner, orchestrateMove, orchestratorsOf, ROLE_ROWS, rowList, withoutPreset, withRowList, runnersOf, whenUnavailable, matchingPreset, missingStarters, modeOfRole, NOBODY, offersReview, presetDetail, presetForRole, STARTER_PRESETS, presetFrom, presetSummary, sanitizeWhoDoesWhat, whoDoesWhatProblem, type ModelPreset } from './shared/who-does-what.ts';
import { whoDoesWhatRoute } from './who-does-what/api.ts';
import { WhoDoesWhatPrefs } from './who-does-what/prefs.ts';

const astra: ModelPreset = { id: 'astra', name: 'Astra', agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false };
const daily: ModelPreset = { id: 'daily', name: 'Everyday', agent: 'claude', model: '', effort: '', fast: true };
const record = { presets: [astra, daily], roles: { design: 'astra', build: 'daily', review: null }, reviewers: [], modes: { design: 'auto', build: 'ask', review: 'auto' }, fallbacks: { design: [], build: [] }, whenUnavailable: 'ask' as const, orchestrate: null, orchestrators: [], reviewOffer: true, instruction: 'Astra does anything visual.' };

describe('presets', () => {
  it('apply their agent, model, effort and fast mode to the controls, and nothing else', () => {
    const controls = { ...DEFAULT_CONTROLS, projectId: 'p', permission: 'auto' as const };
    expect(applyPreset(controls, astra)).toEqual({ ...controls, agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false });
  });

  it('are the chosen one only while the controls match exactly', () => {
    const controls = applyPreset(DEFAULT_CONTROLS, astra);
    expect(matchingPreset([daily, astra], controls)).toBe(astra);
    expect(matchingPreset([daily, astra], { ...controls, effort: 'low' })).toBeUndefined();
    expect(matchingPreset([daily], { agent: 'claude', model: '', fast: true })).toBe(daily);
  });

  it('are made from the controls, and say what they are', () => {
    expect(presetFrom('Deep', { agent: 'claude', model: 'opus' })).toEqual({ name: 'Deep', agent: 'claude', model: 'opus', effort: '', fast: false });
    expect(presetSummary(astra)).toBe('Codex · gpt-6.2-astra · High');
    expect(presetSummary(daily, 'Sonnet 5.5')).toBe('Claude · Sonnet 5.5 · Fast');
    expect(presetSummary({ agent: 'opencode', model: '', effort: '', fast: false })).toBe('OpenCode · Default model');
  });
});

describe('a preset in full, and the ones to start from', () => {
  it('names the agent, the model as its agent calls it, and the effort even when it is the default', () => {
    expect(presetDetail(astra, 'GPT-6.2 Astra')).toBe('Codex · GPT-6.2 Astra · High effort');
    expect(presetDetail(daily, 'Sonnet 5.5')).toBe('Claude · Sonnet 5.5 · Default effort · Fast');
  });

  it('offers the common presets that are not there yet, whatever their case', () => {
    expect(missingStarters([])).toEqual(['Everyday coding', 'Complex multi-step coding', 'Orchestration and deep logic', 'Design and visual work', 'Adversarial review']);
    expect(missingStarters(['everyday coding ', 'Adversarial review', 'Mine'])).toEqual(['Complex multi-step coding', 'Orchestration and deep logic', 'Design and visual work']);
    expect(STARTER_PRESETS.every((name) => name.length <= 30)).toBe(true);
  });
});

describe('the record', () => {
  it('is refused with the reason when it cannot be used', () => {
    expect(whoDoesWhatProblem(record)).toBeNull();
    expect(whoDoesWhatProblem({ ...record, presets: 'x' })).toBe('Send the presets as a list.');
    expect(whoDoesWhatProblem({ ...record, presets: [{ ...astra, name: '' }] })).toBe('Give every preset a name.');
    expect(whoDoesWhatProblem({ ...record, presets: [{ ...astra, agent: 'gemini' }] })).toBe('Astra: pick the agent it runs on.');
    expect(whoDoesWhatProblem({ ...record, presets: [astra, { ...daily, name: 'astra' }] })).toBe('Two presets are called "astra". Give each its own name.');
    expect(whoDoesWhatProblem({ ...record, instruction: 'x'.repeat(2001) })).toBe('The instruction can be at most 2000 characters.');
    expect(whoDoesWhatProblem({ ...record, presets: Array.from({ length: 13 }, (_, i) => ({ ...astra, id: `p${i}`, name: `P${i}` })) })).toBe('There can be at most 12 presets.');
  });

  it('gives a new preset an id, and points a role at nothing when its preset is gone', () => {
    let n = 0;
    const cleaned = cleanWhoDoesWhat({ presets: [astra, { name: ' New ', agent: 'claude', model: '', effort: '' }], roles: { design: 'astra', build: 'gone', review: 7 }, instruction: '  Keep it short.  ' }, () => `new${++n}`);
    expect(cleaned.presets[1]).toEqual({ id: 'new1', name: 'New', agent: 'claude', model: '', effort: '', fast: false });
    expect(cleaned.roles).toEqual({ design: 'astra', build: null, review: null });
    expect(cleaned.instruction).toBe('Keep it short.');
    expect(presetForRole(cleaned, 'design')).toEqual(astra);
    expect(presetForRole(cleaned, 'review')).toBeNull();
  });

  it('leaves a role that is switched off to the session’s own agent, and offers a review only when someone reviews', () => {
    const base = cleanWhoDoesWhat({ presets: [astra], roles: { design: 'astra', review: 'astra' }, instruction: '' }, () => 'x');
    expect(modeOfRole(base, 'design')).toBe('auto');
    expect(offersReview(base)).toBe(true);
    const off = { ...base, modes: { design: 'off' as const, build: 'auto' as const, review: 'off' as const } };
    expect(presetForRole(off, 'design')).toBeNull();
    expect(offersReview(off)).toBe(false);
    expect(offersReview({ ...base, reviewOffer: false })).toBe(false);
    expect(offersReview(NOBODY)).toBe(false);
  });

  it('reads back anything unreadable as nothing, and drops presets it cannot read', () => {
    expect(sanitizeWhoDoesWhat(null)).toEqual(NOBODY);
    expect(sanitizeWhoDoesWhat({ presets: [astra, { name: 'no id', agent: 'claude', model: '', effort: '' }, 'junk'], roles: { design: 'astra' }, modes: { design: 'off', build: 'sideways' }, reviewOffer: false })).toEqual({ presets: [astra], roles: { design: 'astra', build: null, review: null }, reviewers: [], modes: { design: 'off', build: 'auto', review: 'auto' }, fallbacks: { design: [], build: [] }, whenUnavailable: 'ask', orchestrate: null, orchestrators: [], reviewOffer: false, instruction: '' });
  });

  it('is served and stored over HTTP', async () => {
    const prefs = new WhoDoesWhatPrefs();
    const route = (method: string, body: Record<string, unknown> = {}) => whoDoesWhatRoute(['api', 'who-does-what'], method, async () => body, prefs);
    expect(await route('GET')).toEqual({ status: 200, body: NOBODY });
    expect(await route('PUT', { presets: [] })).toEqual({ status: 400, body: { error: 'Send the instruction as text; empty for none.' } });
    expect(await route('PUT', record)).toEqual({ status: 200, body: record });
    expect(await prefs.current()).toEqual(record);
    expect(await whoDoesWhatRoute(['api', 'other'], 'GET', async () => ({}), prefs)).toBeNull();
  });
});

describe('a role’s fallbacks and the Orchestrate role', () => {
  const sonnet: ModelPreset = { id: 'sonnet', name: 'Sonnet', agent: 'claude', model: 'sonnet', effort: '', fast: false };
  const clean = (extra: Record<string, unknown>) => cleanWhoDoesWhat({ presets: [astra, daily, sonnet], roles: { design: 'astra', build: null }, instruction: '', ...extra }, () => 'x');

  it('keeps each fallback once, never the first choice, none for a role left to the session, and asks by default', () => {
    const who = clean({ fallbacks: { design: ['sonnet', 'astra', 'sonnet', 'gone', 'daily'], build: ['sonnet'] } });
    expect(who.fallbacks).toEqual({ design: ['sonnet', 'daily'], build: [] });
    expect(runnersOf(who, 'design').map((p) => p.id)).toEqual(['astra', 'sonnet', 'daily']);
    expect(runnersOf(who, 'build')).toEqual([]);
    expect(whenUnavailable(who)).toBe('ask');
    expect(whenUnavailable(clean({ whenUnavailable: 'auto' }))).toBe('auto');
    expect(whenUnavailable(clean({ whenUnavailable: 'whatever' }))).toBe('ask');
    // A role switched off has nobody, fallbacks included.
    expect(runnersOf({ ...who, modes: { design: 'off', build: 'auto', review: 'auto' } }, 'design')).toEqual([]);
  });

  it('gives the work to the first not tried whose agent is connected', () => {
    const runners = [astra, sonnet, daily];
    expect(nextRunner(runners, [], ['claude', 'codex'])).toBe(astra);
    expect(nextRunner(runners, [], ['claude'])).toBe(sonnet);
    expect(nextRunner(runners, ['astra', 'sonnet'], ['claude', 'codex'])).toBe(daily);
    expect(nextRunner(runners, ['astra', 'sonnet', 'daily'], ['claude', 'codex'])).toBeNull();
    expect(nextRunner(runners, [], ['opencode'])).toBeNull();
  });

  it('passes work on only for a failure that says the model cannot run now', () => {
    for (const reason of ['Rate limit reached', 'OpenCode: Rate limited', 'quota gone', 'You have hit your usage limit', 'Claude is not signed in', 'HTTP 429', 'Insufficient credits']) expect(cannotRunNow(reason), reason).toBe(true);
    for (const reason of ['TypeError: x is undefined', 'The agent could not be started: spawn ENOENT', 'context window exceeded']) expect(cannotRunNow(reason), reason).toBe(false);
  });

  it('knows who orchestrates, and what leading means for a session', () => {
    // An older record's single choice is read as a list of one; a list keeps the user's order, each once.
    expect(orchestratorsOf(clean({ orchestrate: 'sonnet' }))).toEqual([sonnet]);
    expect(orchestratorsOf(clean({ orchestrate: 'gone' }))).toEqual([]);
    const both = clean({ orchestrators: ['astra', 'sonnet', 'astra', 'gone'] });
    expect(both.orchestrators).toEqual(['astra', 'sonnet']);
    expect(both.orchestrate).toBe('astra');
    expect(orchestrateMove([], { agent: 'claude', model: '' })).toEqual({ move: 'none', preset: null });
    expect(orchestrateMove([sonnet], { agent: 'claude', model: 'sonnet' })).toEqual({ move: 'already', preset: sonnet });
    expect(orchestrateMove([sonnet], { agent: 'claude', model: 'opus', effort: 'high' })).toEqual({ move: 'move', preset: sonnet });
    // A session keeps its agent: it takes the first on its own, and with none is told the first choice.
    expect(orchestrateMove([astra, sonnet], { agent: 'claude', model: '' })).toEqual({ move: 'move', preset: sonnet });
    expect(orchestrateMove([sonnet], { agent: 'codex', model: 'sonnet' })).toEqual({ move: 'other-agent', preset: sonnet });
  });

  it('reads and writes every row of the table as one ordered list', () => {
    const who = clean({ fallbacks: { design: ['sonnet'] }, reviewers: ['daily'], orchestrators: ['sonnet', 'astra'] });
    expect(ROLE_ROWS.map((row) => rowList(who, row))).toEqual([['sonnet', 'astra'], ['astra', 'sonnet'], [], ['daily']]);
    const next = withRowList(withRowList(who, 'design', ['daily', 'astra', 'daily']), 'build', ['sonnet']);
    expect(next.roles).toEqual({ design: 'daily', build: 'sonnet', review: 'daily' });
    expect(next.fallbacks).toEqual({ design: ['astra'], build: [] });
    expect(withRowList(who, 'orchestrate', []).orchestrate).toBeNull();
    expect(withRowList(who, 'review', ['astra', 'daily']).roles.review).toBe('astra');
    // What the server stores is what the table wrote.
    expect(ROLE_ROWS.map((row) => rowList(cleanWhoDoesWhat(next, () => 'x'), row))).toEqual(ROLE_ROWS.map((row) => rowList(next, row)));
    expect(ROLE_ROWS.map((row) => rowList(withoutPreset(who, 'sonnet'), row))).toEqual([['astra'], ['astra'], [], ['daily']]);
  });
});
