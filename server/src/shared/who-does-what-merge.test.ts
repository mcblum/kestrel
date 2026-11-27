// Bringing another computer's presets and Who does what here: a merge that adds what is missing and
// replaces nothing (who-does-what-merge.ts).
import { describe, expect, it } from 'vitest';
import { mergeDone, mergeDoesText, mergeSaidText, mergeWhoDoesWhat } from './who-does-what-merge.ts';
import { cleanWhoDoesWhat, MAX_PRESETS, NOBODY, rowList, whoDoesWhatProblem, type ModelPreset, type WhoDoesWhat } from './who-does-what.ts';

const preset = (id: string, name: string, extra: Partial<ModelPreset> = {}): ModelPreset => ({ id, name, agent: 'claude', model: 'opus', effort: 'high', fast: false, ...extra });
const who = (value: Partial<WhoDoesWhat>): WhoDoesWhat => cleanWhoDoesWhat({ ...NOBODY, ...value }, () => 'x');
/** Ids handed out in order: n1, n2, … */
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};

const other = who({
  presets: [preset('o1', 'Everyday'), preset('o2', 'Deep', { model: 'fable' }), preset('o3', 'Review', { agent: 'codex', model: 'gpt-6' })],
  roles: { design: 'o1', build: 'o2', review: 'o3' },
  reviewers: ['o3', 'o1'],
  fallbacks: { design: ['o2'], build: [] },
  modes: { design: 'ask', build: 'auto', review: 'auto' },
  orchestrators: ['o2'],
  whenUnavailable: 'auto',
  reviewAuto: true,
  instruction: 'Codex reviews; Claude builds.',
});

describe('mergeWhoDoesWhat', () => {
  it('on an empty computer brings everything, under ids of its own, with every row pointed at them', () => {
    const m = mergeWhoDoesWhat(NOBODY, other, ids());
    expect(m.added.map((p) => [p.id, p.name])).toEqual([['n1', 'Everyday'], ['n2', 'Deep'], ['n3', 'Review']]);
    expect(m.rows).toEqual(['orchestrate', 'design', 'build', 'review']);
    expect(rowList(m.who, 'design')).toEqual(['n1', 'n2']);
    expect(rowList(m.who, 'build')).toEqual(['n2']);
    expect(rowList(m.who, 'review')).toEqual(['n3', 'n1']);
    expect(rowList(m.who, 'orchestrate')).toEqual(['n2']);
    expect(m.who.modes?.design).toBe('ask');
    expect(m.who.whenUnavailable).toBe('auto');
    expect(m.who.reviewAuto).toBe(true);
    expect(m.instruction).toBe(true);
    expect(m.who.instruction).toBe('Codex reviews; Claude builds.');
    expect(whoDoesWhatProblem(m.who)).toBeNull();
    // Stored as the setting stores it, nothing is lost.
    expect(cleanWhoDoesWhat(m.who, () => 'y')).toEqual(cleanWhoDoesWhat(m.who, () => 'z'));
    expect(mergeDone(m)).toBe(false);
  });

  it('maps a preset already here to this computer’s id, and adds only the rest', () => {
    const here = who({ presets: [preset('h1', 'everyday ')] });
    const m = mergeWhoDoesWhat(here, other, ids());
    expect(m.added.map((p) => p.name)).toEqual(['Deep', 'Review']);
    expect(m.who.presets.map((p) => p.id)).toEqual(['h1', 'n1', 'n2']);
    expect(rowList(m.who, 'design')).toEqual(['h1', 'n1']);
    expect(rowList(m.who, 'review')).toEqual(['n2', 'h1']);
  });

  it('keeps this computer’s preset when the same name has another model, and brings nothing under it', () => {
    const here = who({ presets: [preset('h1', 'Deep', { model: 'sonnet' })] });
    const m = mergeWhoDoesWhat(here, other, ids());
    expect(m.keptYours).toEqual(['Deep']);
    expect(m.who.presets.find((p) => p.name === 'Deep')).toEqual(preset('h1', 'Deep', { model: 'sonnet' }));
    // Build ran on the other's Deep only, so nothing is set for it.
    expect(m.rows).not.toContain('build');
    expect(rowList(m.who, 'design')).toEqual(['n1']);
    expect(mergeSaidText(m)).toContain('"Deep" is here under the same name with other settings, and this computer\'s is kept.');
  });

  it('never replaces a row, a mode, the fallback choice or the note this computer has', () => {
    const here = who({ presets: [preset('h1', 'Mine', { agent: 'opencode' })], roles: { design: 'h1', build: null, review: null }, modes: { design: 'off', build: 'auto', review: 'auto' }, instruction: 'My own words.' });
    const m = mergeWhoDoesWhat(here, other, ids());
    expect(rowList(m.who, 'design')).toEqual(['h1']);
    expect(m.who.modes?.design).toBe('off');
    expect(m.rows).toEqual(['orchestrate', 'build', 'review']);
    // Design was set here, so whether to ask before a fallback stays this computer's.
    expect(m.who.whenUnavailable).toBe('ask');
    expect(m.instruction).toBe(false);
    expect(m.who.instruction).toBe('My own words.');
  });

  it('brings what fits under the limit and names what did not', () => {
    const full = Array.from({ length: MAX_PRESETS - 1 }, (_, i) => preset(`h${i}`, `Mine ${i}`));
    const m = mergeWhoDoesWhat(who({ presets: full }), other, ids());
    expect(m.added.map((p) => p.name)).toEqual(['Everyday']);
    expect(m.leftOut).toEqual(['Deep', 'Review']);
    expect(m.who.presets).toHaveLength(MAX_PRESETS);
    expect(rowList(m.who, 'review')).toEqual(['n1']);
    expect(rowList(m.who, 'build')).toEqual([]);
    expect(whoDoesWhatProblem(m.who)).toBeNull();
    expect(mergeSaidText(m)).toContain(`"Deep" and "Review" do not fit: there can be at most ${MAX_PRESETS} presets.`);
    expect(mergeDone(m)).toBe(false);
  });

  it('gives an added preset an id no preset here has', () => {
    const m = mergeWhoDoesWhat(who({ presets: [preset('n1', 'Mine')] }), other, () => 'n1');
    expect(new Set(m.who.presets.map((p) => p.id)).size).toBe(4);
  });

  it('is done once run: a second merge changes nothing', () => {
    const once = mergeWhoDoesWhat(NOBODY, other, ids());
    const twice = mergeWhoDoesWhat(once.who, other, ids());
    expect(mergeDone(twice)).toBe(true);
    expect(mergeDoesText(twice)).toBe('');
    expect(mergeSaidText(twice)).toBe('Nothing was missing here.');
  });

  it('says what it will do in one sentence', () => {
    expect(mergeDoesText(mergeWhoDoesWhat(NOBODY, other, ids()))).toBe('Adds 3 presets this computer lacks ("Everyday", "Deep" and "Review"), sets Orchestrate, Design, Build and Review where none is set here, and copies the note on who does what');
  });
});
