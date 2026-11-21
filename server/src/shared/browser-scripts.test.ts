import { describe, expect, it } from 'vitest';
import { actRefusal, clickScript, describeElement, focusForTypingScript, parseAct, parseRead, readScript, refStoreKey, settleTypedScript, submitScript } from './browser-scripts.ts';

const KEY = '__kestrel_refs_test';
/** Compiles the script without running it: a syntax error throws here. */
const compiles = (script: string) => new Function(`return ${script};`);

describe('page scripts', () => {
  it('are each one valid expression', () => {
    for (const script of [readScript(KEY, 20000), clickScript(KEY, 3), focusForTypingScript(KEY, 2, 'hello'), settleTypedScript(KEY, 2, 'hello'), submitScript(KEY, 2)]) expect(() => compiles(script)).not.toThrow();
  });

  it('carry outside text as data, never as code', () => {
    const nasty = '"); alert(1); ("`${x}`</script>\\\n ';
    const script = settleTypedScript(KEY, 2, nasty);
    expect(() => compiles(script)).not.toThrow();
    expect(script).toContain(JSON.stringify(nasty));
    expect(() => compiles(focusForTypingScript("'];alert(1)//", 1, nasty))).not.toThrow();
  });

  it('look refs up in the per-pane map, and clip the page text', () => {
    expect(clickScript(KEY, 7)).toContain(`find(7)`);
    expect(clickScript(KEY, 7)).toContain(JSON.stringify(KEY));
    expect(readScript(KEY, 1234)).toContain('slice(0, 1234)');
  });

  it('refuse password fields before focusing them', () => {
    const script = focusForTypingScript(KEY, 1, 'x');
    expect(script.indexOf("error: 'password'")).toBeGreaterThan(-1);
    expect(script.indexOf("error: 'password'")).toBeLessThan(script.indexOf('el.focus('));
  });

  // Found live: <label>Colour <select>…</select></label> was named "Colour Red Green Blue".
  it('name a control by its label without the controls inside the label', () => {
    const script = readScript(KEY, 100);
    expect(script).toContain('map(labelText)');
    expect(script).toContain("querySelectorAll('select, textarea, input, button').forEach((n) => n.remove())");
  });

  it('get a fresh, unguessable key per pane', () => {
    expect(refStoreKey(() => 0.5)).toMatch(/^__kestrel_refs_[a-z0-9]+$/);
    expect(refStoreKey(() => 0.1)).not.toBe(refStoreKey(() => 0.2));
  });
});

describe('what a read returns', () => {
  it('keeps the expected fields and drops the rest', () => {
    const page = parseRead(
      {
        url: 'https://example.com/',
        title: 'Example',
        text: 'Hello',
        textLength: 5,
        more: true,
        elements: [{ ref: 1, role: 'link', name: 'Docs', detail: '→ https://example.com/docs', extra: 'x' }, { ref: 'two', role: 'button' }, null, { ref: 3, role: 'button', name: 'Go' }],
        evil: () => 1,
      },
      100,
    );
    expect(page).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      text: 'Hello',
      textLength: 5,
      moreElements: true,
      elements: [
        { ref: 1, role: 'link', name: 'Docs', detail: '→ https://example.com/docs' },
        { ref: 3, role: 'button', name: 'Go' },
      ],
    });
  });

  it('clips text the page made too long, and survives garbage', () => {
    expect(parseRead({ text: 'x'.repeat(50) }, 10).text).toHaveLength(10);
    expect(parseRead('nonsense', 10)).toEqual({ url: '', title: '', text: '', textLength: 0, elements: [], moreElements: false });
  });
});

describe('what an action returns', () => {
  it('reads success and each refusal', () => {
    expect(parseAct({ ok: true, role: 'button', name: 'Go' })).toEqual({ ok: true, role: 'button', name: 'Go', selected: false, fallback: false });
    expect(parseAct({ error: 'password', role: 'textbox', name: 'Password' })).toMatchObject({ ok: false, error: 'password' });
    expect(parseAct({ error: 'made-up' })).toMatchObject({ ok: false, error: 'failed' });
    expect(parseAct(undefined)).toMatchObject({ ok: false, error: 'failed' });
  });

  it('explains refusals in words the agent can act on', () => {
    const refusal = (raw: object) => actRefusal(parseAct(raw) as Extract<ReturnType<typeof parseAct>, { ok: false }>, 4);
    expect(refusal({ error: 'password', role: 'textbox', name: 'Password' })).toMatch(/\[4\] textbox "Password" is a password field\. .*ask the user to type it/);
    expect(refusal({ error: 'stale' })).toMatch(/Call browser_read again/);
    expect(refusal({ error: 'no-option', role: 'combobox', name: 'Country', options: ['Norway', 'Peru'] })).toMatch(/Norway, Peru/);
  });

  it('describes an element the way a read lists it', () => {
    expect(describeElement(3, 'button', 'Continue')).toBe('[3] button "Continue"');
    expect(describeElement(9, '', '')).toBe('[9] element');
  });
});
