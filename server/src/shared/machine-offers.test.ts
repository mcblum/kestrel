// The offers record's reading and cleaning (machine-offers.ts): what another computer sends is outside data.
import { describe, expect, it } from 'vitest';
import { asClone, asMachineOffersView, asOffersRecord, cleanText, HIDDEN, offersRecordOf, type RemoteStartChoices } from './machine-offers.ts';

const OFFERS: RemoteStartChoices = {
  here: 'your Mac',
  allowed: true,
  agents: ['claude'],
  presets: [{ id: 'q1', name: 'Quick', agent: 'claude', model: '', effort: '', fast: false }],
  start: { agent: 'claude', model: '', effort: '', fast: false, permission: 'auto' },
  providers: [{ agent: 'claude', name: 'Claude', models: [{ id: '', name: 'Default' }, { id: 'haiku', name: 'Haiku', more: true }], default: '' }],
  missing: [{ agent: 'codex', name: 'Codex', reason: 'Codex is not installed.' }],
  projects: [{ id: 'p1', name: 'Shop', folders: [{ id: 'f1', name: 'shop' }], defaultFolderId: 'f1' }],
};
const MINI = { id: 'mini-1', name: 'Mac mini' };
const WHO = { home: '/Users/example', user: 'example' };

describe('what a computer offers', () => {
  it('reads a record back as it was made, and refuses one that is not', () => {
    const record = offersRecordOf(MINI, 1000, OFFERS);
    expect(asOffersRecord(JSON.parse(JSON.stringify(record)))).toEqual({ machine: MINI, made: 1000, offers: OFFERS });
    expect(asOffersRecord({ ...record, v: 2 })).toBeNull();
    expect(asOffersRecord({ ...record, kind: 'seen' })).toBeNull();
    expect(asOffersRecord({ ...record, offers: { ...OFFERS, providers: undefined } })).toBeNull();
    expect(asOffersRecord({ ...record, offers: { ...OFFERS, start: { ...OFFERS.start, permission: 'bypass' } } })).toBeNull();
    expect(asOffersRecord({ ...record, made: 'yesterday' })).toBeNull();
  });

  it('drops a malformed element of any list and keeps the rest', () => {
    const bad = {
      ...OFFERS,
      agents: ['claude', 'cobol', 7],
      presets: [...OFFERS.presets, { id: 'q2', name: 'No agent' }, 'preset'],
      providers: [...OFFERS.providers, { agent: 'codex', name: 'Codex', models: [{ id: 'x', name: 'X' }], default: 'not-a-row' }, { agent: 'opencode', name: 3, models: [], default: '' }],
      missing: [...OFFERS.missing, { agent: 'opencode', name: 'OpenCode' }],
      projects: [{ ...OFFERS.projects[0], folders: [{ id: 'f1', name: 'shop' }, { id: 5 }], extra: 'ignored' }, { id: '', name: 'No id', folders: [], defaultFolderId: null }, null],
    };
    expect(asOffersRecord(offersRecordOf(MINI, 1000, bad as unknown as RemoteStartChoices))!.offers).toEqual(OFFERS);
    // A default folder that is not one of its folders reads as none.
    const wrongDefault: RemoteStartChoices = { ...OFFERS, projects: [{ ...OFFERS.projects[0]!, defaultFolderId: 'f9' }] };
    expect(asOffersRecord(offersRecordOf(MINI, 1000, wrongDefault))!.offers.projects[0]!.defaultFolderId).toBeNull();
  });

  it('carries a model’s effort levels and fast mode, so a running session there can be changed as at its desk', () => {
    const withEfforts: RemoteStartChoices = { ...OFFERS, providers: [{ ...OFFERS.providers[0]!, models: [{ id: '', name: 'Default', efforts: ['low', 'medium', 'high'], fast: true }] }] };
    expect(asOffersRecord(JSON.parse(JSON.stringify(offersRecordOf(MINI, 1000, withEfforts))))!.offers).toEqual(withEfforts);
    // An effort that is not a short word, and a fast flag that is not true, are dropped; the model stays.
    const odd = { ...OFFERS, providers: [{ ...OFFERS.providers[0]!, models: [{ id: '', name: 'Default', efforts: ['low', 'Very High!', 3], fast: 'yes' }] }] };
    expect(asOffersRecord(offersRecordOf(MINI, 1000, odd as unknown as RemoteStartChoices))!.offers.providers[0]!.models).toEqual([{ id: '', name: 'Default', efforts: ['low'] }]);
  });

  it('keeps only entries of the window’s slice that are held offers under their own machine', () => {
    const held = { machine: MINI, made: 1000, offers: OFFERS };
    expect(asMachineOffersView({ [MINI.id]: held, other: held, bad: 3 })).toEqual({ [MINI.id]: held });
    expect(asMachineOffersView(null)).toEqual({});
  });

  it('writes the home folder as ~ whatever its separators and case, and replaces the user name, an email and a key', () => {
    expect(cleanText('Not found (/Users/example/.local/bin/claude)', WHO)).toBe('Not found (~/.local/bin/claude)');
    expect(cleanText('Not found (/USERS/Example/bin)', WHO)).toBe('Not found (~/bin)');
    expect(cleanText('C:\\Users\\example\\bin', { home: 'C:\\Users\\example', user: 'example' })).toBe('~\\bin');
    expect(cleanText('C:/users/Example/bin', { home: 'C:\\Users\\example', user: 'example' })).toBe('~/bin');
    // Another user's folder that only begins like this one is not this home.
    expect(cleanText('/Users/exampleexample/bin', WHO)).toBe('/Users/exampleexample/bin');
    expect(cleanText('Signed in as example on /Volumes/Work/example/bin', WHO)).toBe('Signed in as (user) on /Volumes/Work/(user)/bin');
    expect(cleanText('Signed in as someone@example.test', WHO)).toBe('Signed in as (an account)');
    expect(cleanText(`token ghp_${'a1B2'.repeat(9)}`, WHO)).toBe(HIDDEN);
    expect(cleanText('Claude', { home: '/', user: '' })).toBe('Claude');
  });
});

describe('the clone mark of a node’s offers (item 64)', () => {
  it('keeps a project’s clone mark, drops a malformed one, and bounds how many ids it carries', () => {
    const marked: RemoteStartChoices = { ...OFFERS, projects: [{ id: 'p2', name: 'Billing', folders: [], defaultFolderId: null, clone: { of: ['p2', 'p3'] } }] };
    expect(asOffersRecord(JSON.parse(JSON.stringify(offersRecordOf(MINI, 1000, marked))))!.offers).toEqual(marked);
    expect(asClone({ of: [] })).toBeNull();
    expect(asClone({ of: 'p2' })).toBeNull();
    expect(asClone({ of: ['p2', 4, ''] })).toEqual({ of: ['p2'] });
    expect(asClone({ of: Array.from({ length: 50 }, (_, i) => `p${i}`) })!.of).toHaveLength(20);
  });
});
