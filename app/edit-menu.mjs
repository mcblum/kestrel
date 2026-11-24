// The right-click menu for text in the window (Matt, 2026-11-24: "make spell check actually work in
// the input box"). Electron underlines a misspelled word but shows no menu of its own: the shell
// listens for the window's `context-menu` event (main.mjs) and builds the menu here from what the
// event says: the misspelled word, Chromium's suggestions for it, and which edits apply.
//
// Where the page opens a menu of its own (a session row, a changed file) it cancels the right-click,
// and Chromium then raises no `context-menu` event, so the two never both show. Typed text inside
// such an area is left to this menu by the page (ui/src/typed-text.ts). In a plain browser the
// browser's own menu does the same; nothing in ui/ depends on the shell for it.
//
// No Electron import, so all of it is tested (edit-menu.test.mjs).

/** At most this many suggestions are offered. */
export const SUGGESTIONS_SHOWN = 5;

/**
 * What a right-click offers, as data, or null for no menu (nothing typed and nothing selected).
 * Items: { kind: 'replace', word } | { kind: 'none' } | { kind: 'learn', word } | { kind: 'separator' }
 * | { kind: 'edit', role: 'cut'|'copy'|'paste'|'selectAll', enabled }.
 * @param {{ isEditable: boolean, misspelledWord?: string, dictionarySuggestions?: string[], selectionText?: string, editFlags?: { canCut?: boolean, canCopy?: boolean, canPaste?: boolean, canSelectAll?: boolean } }} params
 */
export function editMenuItems(params) {
  const flags = params.editFlags ?? {};
  const selected = (params.selectionText ?? '').trim() !== '';
  if (!params.isEditable) return selected ? [{ kind: 'edit', role: 'copy', enabled: true }] : null;
  const items = [];
  const word = (params.misspelledWord ?? '').trim();
  if (word) {
    const suggestions = (params.dictionarySuggestions ?? []).filter((s) => typeof s === 'string' && s !== '').slice(0, SUGGESTIONS_SHOWN);
    if (suggestions.length) for (const s of suggestions) items.push({ kind: 'replace', word: s });
    else items.push({ kind: 'none' });
    items.push({ kind: 'learn', word }, { kind: 'separator' });
  }
  items.push(
    { kind: 'edit', role: 'cut', enabled: flags.canCut === true },
    { kind: 'edit', role: 'copy', enabled: flags.canCopy === true },
    { kind: 'edit', role: 'paste', enabled: flags.canPaste === true },
    { kind: 'edit', role: 'selectAll', enabled: flags.canSelectAll === true },
  );
  return items;
}

const EDIT_LABELS = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' };

/**
 * The items as an Electron menu template. `replace(word)` puts a suggestion in place of the
 * misspelled word; `learn(word)` adds the word to the spelling dictionary.
 */
export function editMenuTemplate(items, { replace, learn }) {
  return items.map((item) => {
    if (item.kind === 'replace') return { label: item.word, click: () => replace(item.word) };
    if (item.kind === 'none') return { label: 'No suggestions', enabled: false };
    if (item.kind === 'learn') return { label: `Add “${item.word}” to the dictionary`, click: () => learn(item.word) };
    if (item.kind === 'separator') return { type: 'separator' };
    return { label: EDIT_LABELS[item.role], role: item.role, enabled: item.enabled };
  });
}

/**
 * The languages to check spelling in, or null to leave it to the system. On a Mac Electron uses the
 * system's spell checker, which follows the system's languages by itself (setting languages there
 * does nothing). On Windows and Linux Electron checks with its own dictionaries and has to be told
 * which: the system's preferred languages it has a dictionary for, matched exactly or by language
 * ("en-AU" takes "en-GB" when that is the only English), else US English when it has it.
 * @param {'mac' | 'windows' | 'linux'} platform
 * @param {string[]} preferred the system's preferred languages, most preferred first
 * @param {string[]} available the languages Electron has dictionaries for
 */
export function spellLanguages(platform, preferred, available) {
  if (platform === 'mac') return null;
  const byLower = new Map(available.map((a) => [a.toLowerCase(), a]));
  const chosen = [];
  const add = (code) => code && !chosen.includes(code) && chosen.push(code);
  for (const raw of preferred) {
    const lang = raw.replace('_', '-').toLowerCase();
    const exact = byLower.get(lang);
    if (exact) add(exact);
    else {
      const base = lang.split('-')[0];
      add(byLower.get(base) ?? available.find((a) => a.toLowerCase().split('-')[0] === base));
    }
  }
  if (chosen.length === 0) add(byLower.get('en-us') ?? byLower.get('en'));
  return chosen;
}
