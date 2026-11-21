// Appearance (shared/appearance.ts): what is stored, what goes on the page, and the terminal's colours.
import { describe, expect, it } from 'vitest';
import { clampTerminalFont, codeFontProblem, codeFontStack, DEFAULT_APPEARANCE, isDark, rootLook, sanitizeAppearance, terminalColors } from './shared/appearance.ts';

describe('appearance', () => {
  it('reads back anything unreadable as the default for that part', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance({ theme: 'sepia', codeFont: ' Fira Code ', terminalFontSize: 99, contrast: 'high', diffColors: 'blue-orange' })).toEqual({ theme: 'system', codeFont: 'Fira Code', terminalFontSize: 24, contrast: 'high', diffColors: 'blue-orange' });
    expect(sanitizeAppearance({ theme: 'dark', codeFont: 'x"; } body { display:none', terminalFontSize: 'big' })).toMatchObject({ theme: 'dark', codeFont: '', terminalFontSize: 12 });
  });

  it('takes a font name only when it is made of what a font name is made of', () => {
    expect(codeFontProblem('JetBrains Mono')).toBeNull();
    expect(codeFontProblem('')).toBeNull();
    expect(codeFontProblem('a";b')).toMatch(/letters, digits/);
    expect(codeFontProblem('x'.repeat(61))).toMatch(/at most 60/);
    expect(codeFontStack('Fira Code')).toBe('"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace');
    expect(codeFontStack('')).toBe('ui-monospace, SFMono-Regular, Menlo, monospace');
    expect(codeFontStack('a";b')).toBe('ui-monospace, SFMono-Regular, Menlo, monospace');
  });

  it('keeps the terminal’s text between 9 and 24', () => {
    expect([clampTerminalFont(2), clampTerminalFont(13.4), clampTerminalFont(40)]).toEqual([9, 13, 24]);
  });

  it('is dark by choice, or by the system when left to it', () => {
    expect([isDark('dark', false), isDark('light', true), isDark('system', true), isDark('system', false)]).toEqual([true, false, true, false]);
  });

  it('says what goes on the page’s root', () => {
    expect(rootLook(DEFAULT_APPEARANCE)).toEqual({ colorScheme: 'light dark', contrast: 'standard', diff: 'red-green', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' });
    expect(rootLook({ ...DEFAULT_APPEARANCE, theme: 'dark', contrast: 'high', diffColors: 'blue-orange', codeFont: 'Menlo' })).toEqual({ colorScheme: 'dark', contrast: 'high', diff: 'blue-orange', mono: '"Menlo", ui-monospace, SFMono-Regular, Menlo, monospace' });
  });

  it('draws the terminal in the app’s greys, with full black or white text at high contrast', () => {
    expect(terminalColors(true, 'standard')).toMatchObject({ background: '#1c1c1d', foreground: '#e6e6e6' });
    expect(terminalColors(false, 'high')).toMatchObject({ background: '#fafafa', foreground: '#000000' });
  });
});
