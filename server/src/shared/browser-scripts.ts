// The small scripts the browser pane runs inside the page (through `webview.executeJavaScript`)
// to read it and act on it, and the checks on what they return. Each builder returns one
// self-contained expression; every value from outside goes in through JSON.stringify, never by
// pasting text into code. What comes back was produced by the page and is untrusted: the parsers
// keep only the expected fields, as strings and numbers of bounded size, and Kestrel only ever
// hands it to the agent as text.
//
// `browser_read` numbers the elements it lists and keeps them in a page-side map (number ->
// WeakRef), stored under a property named per pane so a page cannot guess it in advance. Click
// and type look the number up there.
import type { PageElement } from './browser.ts';

const MAX_ELEMENTS = 400;
const MAX_NAME = 100;
const MAX_DETAIL = 160;
const MAX_TITLE = 300;
const MAX_URL = 2000;

/** A property name for the page-side map: unguessable, and the same for one pane's life. */
export function refStoreKey(random: () => number = Math.random): string {
  return `__kestrel_refs_${Math.floor(random() * 2 ** 48).toString(36)}`;
}

const lit = (value: unknown) => JSON.stringify(value);

/** Shared helpers, in the page: find a ref, describe an element. */
const HELPERS = `
  const store = window[KEY] || (Object.defineProperty(window, KEY, { value: new Map(), enumerable: false, configurable: true }), window[KEY]);
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const textOf = (id) => { const el = document.getElementById(id); return el ? el.innerText || el.textContent || '' : ''; };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  };
  // A <label> wrapped around its control: its words, not the control's own (a select's every option).
  const labelText = (l) => { const c = l.cloneNode(true); c.querySelectorAll('select, textarea, input, button').forEach((n) => n.remove()); return c.textContent || ''; };
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const labels = el.labels ? Array.from(el.labels).map(labelText).join(' ') : '';
    const img = el.querySelector && el.querySelector('img[alt]');
    return clip(el.getAttribute('aria-label') || (by ? by.split(/\\s+/).map(textOf).join(' ') : '') || labels || el.getAttribute('placeholder') ||
      (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? el.value : '') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') ||
      (img ? img.getAttribute('alt') : '') || el.getAttribute('name') || '', ${MAX_NAME});
  };
  const find = (ref) => { const w = store.get(ref); const el = w && w.deref(); return el && el.isConnected ? el : null; };
`;

const wrap = (key: string, body: string) => `(() => { const KEY = ${lit(key)};${HELPERS}${body} })()`;

/** The page's visible text and its interactive elements, numbered. Replaces the previous numbering. */
export function readScript(key: string, maxText: number): string {
  return wrap(
    key,
    `
  const SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=switch], [role=option], [role=combobox], [role=textbox], [contenteditable=""], [contenteditable=true]';
  const shown = (el) => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const all = [];
  const walk = (root) => {
    root.querySelectorAll(SELECTOR).forEach((el) => all.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  store.clear();
  const elements = [];
  let more = false;
  for (const el of all) {
    if (!shown(el)) continue;
    if (elements.length >= ${MAX_ELEMENTS}) { more = true; break; }
    const ref = elements.length + 1;
    store.set(ref, new WeakRef(el));
    const role = roleOf(el);
    const bits = [];
    if (role === 'link') bits.push('→ ' + clip(el.href, ${MAX_DETAIL}));
    if (el.tagName === 'INPUT' && role === 'textbox') bits.push('type=' + (el.getAttribute('type') || 'text'));
    if (role === 'textbox' && el.type !== 'password' && typeof el.value === 'string' && el.value) bits.push('value="' + clip(el.value, 80) + '"');
    if (el.tagName === 'INPUT' && el.type === 'password' && el.value) bits.push('filled');
    if (role === 'checkbox' || role === 'radio') bits.push(el.checked || el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
    if (el.tagName === 'SELECT' && el.selectedOptions.length) bits.push('selected="' + clip(el.selectedOptions[0].text, 80) + '"');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    elements.push({ ref, role, name: nameOf(el), detail: bits.join(' ') });
  }
  const text = (document.body ? document.body.innerText : '') || '';
  return { url: location.href, title: document.title, text: text.slice(0, ${Math.max(0, Math.floor(maxText))}), textLength: text.length, elements, more };
`,
  );
}

/** Click the element numbered `ref` by the last read. */
export function clickScript(key: string, ref: number): string {
  return wrap(
    key,
    `
  const el = find(${lit(ref)});
  if (!el) return { error: 'stale' };
  const what = { role: roleOf(el), name: nameOf(el) };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'disabled', ...what };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.click();
  return { ok: true, ...what };
`,
  );
}

/**
 * Get the element numbered `ref` ready for typing: focused, its current text selected so typing
 * replaces it. Refuses password fields. For a <select>, picks the option whose text or value is
 * `text` instead, since there is nothing to type into.
 */
export function focusForTypingScript(key: string, ref: number, text: string): string {
  return wrap(
    key,
    `
  const el = find(${lit(ref)});
  if (!el) return { error: 'stale' };
  const what = { role: roleOf(el), name: nameOf(el) };
  const type = (el.getAttribute('type') || '').toLowerCase();
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (type === 'password' || auto.includes('current-password') || auto.includes('new-password')) return { error: 'password', ...what };
  if (el.disabled || el.readOnly) return { error: 'disabled', ...what };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (el.tagName === 'SELECT') {
    const want = ${lit(text)};
    const opt = Array.from(el.options).find((o) => o.value === want || o.text.trim() === want.trim());
    if (!opt) return { error: 'no-option', ...what, options: Array.from(el.options).slice(0, 30).map((o) => clip(o.text, 60)) };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: true, ...what };
  }
  const editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  if (!editable) return { error: 'not-editable', ...what };
  el.focus({ preventScroll: true });
  if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  else if (typeof el.select === 'function') el.select();
  return { ok: true, ...what };
`,
  );
}

/**
 * After typing: whether the element now holds `text`; if not (the real keystrokes did not land),
 * set it directly, the way frameworks notice: through the native value setter, then `input` and
 * `change` events.
 */
export function settleTypedScript(key: string, ref: number, text: string): string {
  return wrap(
    key,
    `
  const el = find(${lit(ref)});
  if (!el) return { error: 'stale' };
  const want = ${lit(text)};
  const current = el.isContentEditable ? el.innerText : el.value;
  if (current === want) return { ok: true };
  if (el.isContentEditable) { el.textContent = want; }
  else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, want);
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: want, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, fallback: true };
`,
  );
}

/** Submit the element's form, or press Enter on it when it has none. Used after typing with `submit`. */
export function submitScript(key: string, ref: number): string {
  return wrap(
    key,
    `
  const el = find(${lit(ref)});
  if (!el) return { error: 'stale' };
  if (el.form) { if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit(); return { ok: true, form: true }; }
  for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  return { ok: true, form: false };
`,
  );
}

// ---- what comes back ------------------------------------------------------------------------------

const text = (value: unknown, max: number) => (typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : '');

export interface PageRead {
  url: string;
  title: string;
  text: string;
  /** The text's full length on the page, before it was clipped. */
  textLength: number;
  elements: PageElement[];
  moreElements: boolean;
}

/** Keep only well-formed fields of what `readScript` returned. */
export function parseRead(raw: unknown, maxText: number): PageRead {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(r.elements) ? r.elements.slice(0, MAX_ELEMENTS) : [];
  const elements = list.flatMap((e): PageElement[] => {
    const item = (e ?? {}) as Record<string, unknown>;
    if (typeof item.ref !== 'number' || !Number.isSafeInteger(item.ref)) return [];
    const detail = text(item.detail, MAX_DETAIL);
    return [{ ref: item.ref, role: text(item.role, 30) || 'element', name: text(item.name, MAX_NAME), ...(detail ? { detail } : {}) }];
  });
  const body = text(r.text, maxText);
  return {
    url: text(r.url, MAX_URL),
    title: text(r.title, MAX_TITLE),
    text: body,
    textLength: typeof r.textLength === 'number' && r.textLength >= body.length ? r.textLength : body.length,
    elements,
    moreElements: r.more === true,
  };
}

/** What a click, focus, settle or submit script said. */
export type ActOutcome =
  | { ok: true; role: string; name: string; selected: boolean; fallback: boolean }
  | { ok: false; error: 'stale' | 'disabled' | 'password' | 'not-editable' | 'no-option' | 'failed'; role: string; name: string; options: string[] };

const ACT_ERRORS = new Set(['stale', 'disabled', 'password', 'not-editable', 'no-option']);

export function parseAct(raw: unknown): ActOutcome {
  const r = (raw ?? {}) as Record<string, unknown>;
  const role = text(r.role, 30);
  const name = text(r.name, MAX_NAME);
  if (r.ok === true) return { ok: true, role, name, selected: r.selected === true, fallback: r.fallback === true };
  const error = typeof r.error === 'string' && ACT_ERRORS.has(r.error) ? (r.error as Exclude<ActOutcome, { ok: true }>['error']) : 'failed';
  const options = Array.isArray(r.options) ? r.options.slice(0, 30).map((o) => text(o, 60)) : [];
  return { ok: false, error, role, name, options };
}

/** One element, the way the agent sees it in a read: `[3] button "Continue"`. */
export function describeElement(ref: number, role: string, name: string): string {
  return `[${ref}] ${role || 'element'}${name ? ` "${name}"` : ''}`;
}

/** Why an action on an element was refused, in words the agent can act on. */
export function actRefusal(outcome: Extract<ActOutcome, { ok: false }>, ref: number): string {
  const el = describeElement(ref, outcome.role, outcome.name);
  switch (outcome.error) {
    case 'stale':
      return `There is no element ${ref} on the page any more (it changed, or it was never listed). Call browser_read again and use a ref from that.`;
    case 'disabled':
      return `${el} is disabled.`;
    case 'password':
      return `${el} is a password field. Kestrel does not type passwords: ask the user to type it into the browser pane themselves, then continue.`;
    case 'not-editable':
      return `${el} is not something you can type into. Pick a textbox or combobox from browser_read.`;
    case 'no-option':
      return `${el} has no option matching that text. Give one of its options exactly: ${outcome.options.join(', ') || '(none)'}.`;
    default:
      return `The page did not let Kestrel act on element ${ref}.`;
  }
}
