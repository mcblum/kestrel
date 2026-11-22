import { describe, expect, it } from 'vitest';
import { DEFAULT_COLOURS, nextWorkstreamColour, sanitizeColours, sessionColour, tagColour, workstreamColour } from '../shared/colours.ts';
import { coloursRoute } from './api.ts';
import { ColourPrefs } from './prefs.ts';

const put = (prefs: ColourPrefs, body: Record<string, unknown>) => coloursRoute(['api', 'colours'], 'PUT', async () => body, prefs);

describe('colour settings', () => {
  it('keeps only palette colours, and drops what is no longer coloured (groups, the fixed elements)', () => {
    expect(sanitizeColours(null)).toEqual(DEFAULT_COLOURS);
    expect(sanitizeColours({ elements: { review: 'purple' }, groups: { g1: 'brown' }, tags: { Argus: 'red', Infra: 'blue' }, workstreams: { w1: 'teal', w2: 'green' } })).toEqual({
      tags: { infra: 'blue' },
      projects: {},
      workstreams: { w1: 'teal' },
      workstreamColours: true,
    });
  });

  it("marks a session with its project's colour only; a tag's colour stays on the tag", () => {
    const colours = sanitizeColours({ tags: { argus: 'blue' }, projects: { terraform: 'orange' } });
    expect(sessionColour(colours, { filing: { projectId: 'terraform' } })).toBe('orange');
    expect(sessionColour(colours, { filing: { projectId: null } })).toBeNull();
    expect(tagColour(colours, 'ARGUS')).toBe('blue');
  });
});

describe('PUT /api/colours', () => {
  it('colours a tag, and null takes the colour off', async () => {
    const prefs = new ColourPrefs();
    await put(prefs, { tag: ' Argus ', colour: 'teal' });
    expect((await prefs.current()).tags).toEqual({ argus: 'teal' });
    await put(prefs, { tag: 'ARGUS', colour: null });
    expect((await prefs.current()).tags).toEqual({});
  });

  it('colours a project by its id, and null takes it off', async () => {
    const prefs = new ColourPrefs();
    await put(prefs, { project: 'terraform', colour: 'orange' });
    expect((await prefs.current()).projects).toEqual({ terraform: 'orange' });
    await put(prefs, { project: 'terraform', colour: null });
    expect((await prefs.current()).projects).toEqual({});
    expect((await put(prefs, { project: '', colour: 'orange' }))?.status).toBe(400);
  });

  it('colours a workstream by its id, and null takes it off', async () => {
    const prefs = new ColourPrefs();
    const answer = await put(prefs, { workstream: 'w1', colour: 'indigo' });
    expect(answer).toEqual({ status: 200, body: { tags: {}, projects: {}, workstreams: { w1: 'indigo' }, workstreamColours: true } });
    expect(workstreamColour(await prefs.current(), 'w1')).toBe('indigo');
    await put(prefs, { workstream: 'w1', colour: null });
    expect(workstreamColour(await prefs.current(), 'w1')).toBeNull();
  });

  it('refuses a colour outside the palette, and what is no longer coloured, with the reason', async () => {
    const prefs = new ColourPrefs();
    const tag = await put(prefs, { tag: 'Argus', colour: 'green' });
    expect(tag).toEqual({ status: 400, body: { error: expect.stringContaining('teal') } });
    expect((await put(prefs, { elements: { review: 'blue' } }))?.status).toBe(400);
    expect((await put(prefs, { group: 'g1', colour: 'brown' }))?.status).toBe(400);
    expect(await prefs.current()).toEqual(DEFAULT_COLOURS);
  });
});

describe("a new workstream's colour", () => {
  it('is the one the fewest listed workstreams use, never grey, ties going in palette order', () => {
    expect(nextWorkstreamColour(DEFAULT_COLOURS, [])).toBe('brown');
    const colours = sanitizeColours({ workstreams: { a: 'brown', b: 'orange', gone: 'teal' } });
    expect(nextWorkstreamColour(colours, ['a', 'b'])).toBe('teal');
    expect(nextWorkstreamColour(colours, ['a', 'b', 'gone'])).toBe('blue');
  });

  it('is given once, kept when the user changed it, and not given while workstreams are not coloured', async () => {
    const prefs = new ColourPrefs();
    await prefs.autoColourWorkstream('w1', ['w1']);
    expect((await prefs.current()).workstreams).toEqual({ w1: 'brown' });
    await put(prefs, { workstream: 'w1', colour: 'pink' });
    await prefs.autoColourWorkstream('w1', ['w1']);
    expect((await prefs.current()).workstreams.w1).toBe('pink');
    await put(prefs, { workstreamColours: false });
    await prefs.autoColourWorkstream('w2', ['w1', 'w2']);
    const off = await prefs.current();
    expect(off.workstreams).toEqual({ w1: 'pink' });
    expect(workstreamColour(off, 'w1')).toBeNull();
    expect((await put(prefs, { workstreamColours: 'yes' }))?.status).toBe(400);
  });
});
