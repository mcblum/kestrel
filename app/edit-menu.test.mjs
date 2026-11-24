import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editMenuItems, editMenuTemplate, spellLanguages, SUGGESTIONS_SHOWN } from './edit-menu.mjs';

const flags = (on = true) => ({ canCut: on, canCopy: on, canPaste: on, canSelectAll: on });
const roles = (items) => items.filter((i) => i.kind === 'edit').map((i) => [i.role, i.enabled]);

test('a misspelled word: its suggestions first, then add to the dictionary, then the edit items', () => {
  const items = editMenuItems({ isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive', 'relieve'], editFlags: flags() });
  assert.deepEqual(items.slice(0, 4), [{ kind: 'replace', word: 'receive' }, { kind: 'replace', word: 'relieve' }, { kind: 'learn', word: 'recieve' }, { kind: 'separator' }]);
  assert.deepEqual(roles(items), [['cut', true], ['copy', true], ['paste', true], ['selectAll', true]]);
});

test('a misspelled word with no suggestions says so, greyed, and can still be added', () => {
  const items = editMenuItems({ isEditable: true, misspelledWord: 'kestrelish', dictionarySuggestions: [], editFlags: flags() });
  assert.deepEqual(items.slice(0, 2), [{ kind: 'none' }, { kind: 'learn', word: 'kestrelish' }]);
  const template = editMenuTemplate(items, { replace() {}, learn() {} });
  assert.deepEqual(template[0], { label: 'No suggestions', enabled: false });
});

test('only the first few suggestions are offered', () => {
  const items = editMenuItems({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tech', 'tea', 'tee', 'Ted', 'eh'], editFlags: flags() });
  assert.equal(items.filter((i) => i.kind === 'replace').length, SUGGESTIONS_SHOWN);
});

test('typed text with no misspelling: just the edit items, each enabled only when it applies', () => {
  const items = editMenuItems({ isEditable: true, misspelledWord: '', dictionarySuggestions: [], editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
  assert.deepEqual(roles(items), [['cut', false], ['copy', false], ['paste', true], ['selectAll', true]]);
  assert.equal(items.length, 4);
});

test('read-only text: Copy when something is selected, and no menu otherwise', () => {
  assert.deepEqual(editMenuItems({ isEditable: false, selectionText: 'some words', editFlags: flags(false) }), [{ kind: 'edit', role: 'copy', enabled: true }]);
  assert.equal(editMenuItems({ isEditable: false, selectionText: '  ', editFlags: flags(false) }), null);
  assert.equal(editMenuItems({ isEditable: false }), null);
});

test('choosing a suggestion replaces the word; adding puts the word in the dictionary', () => {
  const done = [];
  const items = editMenuItems({ isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive'], editFlags: flags() });
  const template = editMenuTemplate(items, { replace: (w) => done.push(['replace', w]), learn: (w) => done.push(['learn', w]) });
  template[0].click();
  template[1].click();
  assert.deepEqual(done, [['replace', 'receive'], ['learn', 'recieve']]);
  assert.equal(template[1].label, 'Add “recieve” to the dictionary');
  assert.deepEqual(template.slice(3).map((t) => [t.label, t.role]), [['Cut', 'cut'], ['Copy', 'copy'], ['Paste', 'paste'], ['Select All', 'selectAll']]);
});

test('languages: left to the system on a Mac; on Windows and Linux the preferred ones there are dictionaries for', () => {
  const available = ['en-US', 'en-GB', 'de-DE', 'fr', 'pt-BR'];
  assert.equal(spellLanguages('mac', ['de-DE'], available), null);
  for (const platform of ['windows', 'linux']) {
    assert.deepEqual(spellLanguages(platform, ['en-GB', 'de-DE'], available), ['en-GB', 'de-DE']);
    assert.deepEqual(spellLanguages(platform, ['fr-CA', 'pt'], available), ['fr', 'pt-BR'], 'matched by language');
    assert.deepEqual(spellLanguages(platform, ['de_DE'], available), ['de-DE'], 'an underscore form');
    assert.deepEqual(spellLanguages(platform, ['ja-JP'], available), ['en-US'], 'none there: US English');
    assert.deepEqual(spellLanguages(platform, ['ja-JP'], ['de-DE']), [], 'not even that: nothing to check with');
  }
});
