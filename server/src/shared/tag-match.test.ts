import { describe, expect, it } from 'vitest';
import { closestExistingTag, MAX_PICKED_TAGS, OFFERED_TAGS, offeredTags, pickedTags, typedTag, withClicked, withTyped } from './tag-match.ts';

describe('closestExistingTag', () => {
  it('folds an existing tag plus extra words into the existing tag', () => {
    expect(closestExistingTag('Argus CLI', ['Argus'])).toBe('Argus');
    expect(closestExistingTag('the Argus deploy work', ['Billing', 'Argus'])).toBe('Argus');
    expect(closestExistingTag('argus-cli', ['Argus'])).toBe('Argus');
  });

  it('takes an existing tag written another way: case, spacing, punctuation', () => {
    expect(closestExistingTag('argus', ['Argus'])).toBe('Argus');
    expect(closestExistingTag('dark mode', ['Dark-Mode'])).toBe('Dark-Mode');
    expect(closestExistingTag('DarkMode', ['dark mode'])).toBe('dark mode');
    expect(closestExistingTag('plat 1234', ['PLAT-1234'])).toBe('PLAT-1234');
  });

  it('keeps a tag of its own when no existing tag covers it', () => {
    expect(closestExistingTag('Billing', ['Argus'])).toBeNull();
    expect(closestExistingTag('Argus', [])).toBeNull();
    // A part of a word is not the word.
    expect(closestExistingTag('Argusto CLI', ['Argus'])).toBeNull();
    // A shorter proposal is never widened into a longer existing tag.
    expect(closestExistingTag('Argus', ['Argus CLI'])).toBeNull();
  });

  it('never folds a ticket or a version into a tag that is its start', () => {
    expect(closestExistingTag('PLAT-1234', ['PLAT'])).toBeNull();
    expect(closestExistingTag('Argus v2', ['Argus'])).toBeNull();
    expect(closestExistingTag('v1.2', ['v12'])).toBeNull();
    expect(closestExistingTag('0.0.32', ['0.03.2'])).toBeNull();
    expect(closestExistingTag('PROJ-482', ['PROJ-48'])).toBeNull();
  });

  it('prefers the longest existing tag it adds words to, then the first given', () => {
    expect(closestExistingTag('Argus CLI flags', ['Argus', 'Argus CLI'])).toBe('Argus CLI');
    expect(closestExistingTag('Argus billing', ['Billing', 'Argus'])).toBe('Billing');
  });

  it('leaves a tag with no letters or digits to an exact match only', () => {
    expect(closestExistingTag('!!', ['!!'])).toBe('!!');
    expect(closestExistingTag('!!', ['??'])).toBeNull();
  });
});

describe('typedTag', () => {
  it('follows an existing tag in case only', () => {
    expect(typedTag('argus', ['Argus'])).toBe('Argus');
    // What the user typed on purpose is not folded.
    expect(typedTag('Argus CLI', ['Argus'])).toBe('Argus CLI');
  });
});

describe('pickedTags', () => {
  it('cleans each, writes existing tags their own way and drops repeats', () => {
    expect(pickedTags(['  argus ', 'New  one', 'ARGUS'], ['Argus'])).toEqual({ tags: ['Argus', 'New one'] });
  });

  it('refuses none, too many, and what is not a tag', () => {
    expect(pickedTags([], [])).toEqual({ reason: 'Choose at least one tag.' });
    expect(pickedTags([7], [])).toEqual({ reason: 'A tag must be text.' });
    expect(pickedTags(Array.from({ length: MAX_PICKED_TAGS + 1 }, (_, i) => `t${i}`), [])).toEqual({ reason: `At most ${MAX_PICKED_TAGS} tags at a time.` });
  });
});

describe('withTyped', () => {
  it('adds what was typed, split at commas, an existing tag in its own case', () => {
    expect(withTyped(['PROJ-1'], ' argus, New  one ,', ['Argus'])).toEqual(['PROJ-1', 'Argus', 'New one']);
  });

  it('is the same array when nothing is added: empty text, or a tag already chosen', () => {
    const chosen = ['Argus'];
    expect(withTyped(chosen, '  ', [])).toBe(chosen);
    expect(withTyped(chosen, 'ARGUS', [])).toBe(chosen);
  });

  it('stops at the most tags one answer may add', () => {
    const typed = Array.from({ length: MAX_PICKED_TAGS + 3 }, (_, i) => `t${i}`).join(',');
    expect(withTyped([], typed, [])).toHaveLength(MAX_PICKED_TAGS);
  });
});

describe('withClicked', () => {
  it('the first other tag clicked takes the place of the untouched suggestion', () => {
    expect(withClicked(['Argus CLI'], 'Argus', true)).toEqual(['Argus']);
  });

  it('once the choice was changed, a click adds, and a click on a chosen tag takes it off', () => {
    expect(withClicked(['Argus'], 'Billing', false)).toEqual(['Argus', 'Billing']);
    expect(withClicked(['Argus', 'Billing'], 'argus', false)).toEqual(['Billing']);
    // The suggested chip, clicked again after it was replaced, comes back beside what was chosen.
    expect(withClicked(['Argus'], 'Argus CLI', false)).toEqual(['Argus', 'Argus CLI']);
  });

  it('a click on the untouched suggestion itself takes it off', () => {
    expect(withClicked(['Argus CLI'], 'Argus CLI', true)).toEqual([]);
  });

  it('adds nothing past the most tags one answer may add', () => {
    const full = Array.from({ length: MAX_PICKED_TAGS }, (_, i) => `t${i}`);
    expect(withClicked(full, 'one more', false)).toBe(full);
  });
});

describe('offeredTags', () => {
  const sessions = [
    { tags: ['Argus', 'perf'], updatedAt: 10 },
    { tags: ['Billing'], updatedAt: 30 },
    { tags: ['argus', 'Docs'], updatedAt: 20 },
  ];

  it('lists tags named in what the session is about first, then the most recently used', () => {
    expect(offeredTags({ suggested: 'PROJ-1', sessionTags: [], sessions, texts: ['speed up the docs build'] })).toEqual(['Docs', 'Billing', 'Argus', 'perf']);
  });

  it('leaves out the suggested tag and the tags the session has, and writes a tag as first written', () => {
    expect(offeredTags({ suggested: 'billing', sessionTags: ['DOCS'], sessions, texts: [] })).toEqual(['Argus', 'perf']);
  });

  it('offers a short, fixed number', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ tags: [`tag-${i}`], updatedAt: i }));
    const offered = offeredTags({ suggested: 'x', sessionTags: [], sessions: many, texts: [] });
    expect(offered).toHaveLength(OFFERED_TAGS);
    expect(offered[0]).toBe('tag-11');
  });
});
