// Appearance (shared/appearance.ts): what is stored, what goes on the page, and the terminal's colours.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAT_TEXT_SCALES, clampComposerFont, clampTerminalFont, codeFontProblem, codeFontStack, DEFAULT_APPEARANCE, isDark, nearestChatScale, rootLook, sanitizeAppearance, scalePercent, terminalColors } from './shared/appearance.ts';

describe('appearance', () => {
  it('reads back anything unreadable as the default for that part', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance({ theme: 'sepia', codeFont: ' Fira Code ', terminalFontSize: 99, composerFontSize: 99, chatTextScale: 9, contrast: 'high', diffColors: 'blue-orange' })).toEqual({ theme: 'system', codeFont: 'Fira Code', terminalFontSize: 24, composerFontSize: 20, chatTextScale: 1.5, contrast: 'high', diffColors: 'blue-orange' });
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

  it('reads an appearance stored before the text sizes as the default sizes, keeping the rest', () => {
    const stored = { theme: 'dark', codeFont: 'Menlo', terminalFontSize: 15, contrast: 'high', diffColors: 'blue-orange' };
    expect(sanitizeAppearance(stored)).toEqual({ ...stored, composerFontSize: 14, chatTextScale: 1 });
  });

  it('falls back to the default text sizes for what is not a number', () => {
    for (const bad of ['16', null, Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(sanitizeAppearance({ composerFontSize: bad, chatTextScale: bad })).toMatchObject({ composerFontSize: 14, chatTextScale: 1 });
    }
  });

  it('keeps the message box’s text between 12 and 20, in whole pixels, 14 unless changed', () => {
    expect(DEFAULT_APPEARANCE.composerFontSize).toBe(14);
    expect([clampComposerFont(4), clampComposerFont(15.6), clampComposerFont(30)]).toEqual([12, 16, 20]);
    expect(sanitizeAppearance({ composerFontSize: 0 }).composerFontSize).toBe(12);
  });

  it('takes a conversation’s scale as the nearest offered one, 100% unless changed', () => {
    expect(DEFAULT_APPEARANCE.chatTextScale).toBe(1);
    expect(CHAT_TEXT_SCALES).toContain(1);
    expect([nearestChatScale(0.1), nearestChatScale(1.04), nearestChatScale(1.2), nearestChatScale(1.1), nearestChatScale(7)]).toEqual([0.85, 1, 1.25, 1.1, 1.5]);
    expect(sanitizeAppearance({ chatTextScale: 1.24 }).chatTextScale).toBe(1.25);
    expect(CHAT_TEXT_SCALES.map(scalePercent)).toEqual(['85%', '90%', '100%', '110%', '125%', '150%']);
  });

  it('keeps the terminal’s text between 9 and 24', () => {
    expect([clampTerminalFont(2), clampTerminalFont(13.4), clampTerminalFont(40)]).toEqual([9, 13, 24]);
  });

  it('is dark by choice, or by the system when left to it', () => {
    expect([isDark('dark', false), isDark('light', true), isDark('system', true), isDark('system', false)]).toEqual([true, false, true, false]);
  });

  it('says what goes on the page’s root', () => {
    expect(rootLook(DEFAULT_APPEARANCE)).toEqual({
      colorScheme: 'light dark', contrast: 'standard', diff: 'red-green',
      properties: { '--mono': 'ui-monospace, SFMono-Regular, Menlo, monospace', '--composer-font-size': '14px', '--chat-text-scale': '1' },
    });
    expect(rootLook({ ...DEFAULT_APPEARANCE, theme: 'dark', contrast: 'high', diffColors: 'blue-orange', codeFont: 'Menlo', composerFontSize: 18, chatTextScale: 1.25 })).toEqual({
      colorScheme: 'dark', contrast: 'high', diff: 'blue-orange',
      properties: { '--mono': '"Menlo", ui-monospace, SFMono-Regular, Menlo, monospace', '--composer-font-size': '18px', '--chat-text-scale': '1.25' },
    });
  });

  it('puts every custom property on the root, and the stylesheets read the text sizes from them', () => {
    const read = (path: string) => readFileSync(new URL(`../../ui/src/${path}`, import.meta.url), 'utf8');
    // The window sets whatever rootLook names, so a property added there reaches the page.
    expect(read('appearance.ts')).toMatch(/Object\.entries\(look\.properties\)\) root\.style\.setProperty\(name, value\)/);
    // Every message box is drawn at the input size, with the default where the root has none.
    const app = read('styles/app.css');
    expect(app).toContain('.kestrel .composer-box .composer-input { font-size: var(--composer-font-size, 14px);');
    expect(app).not.toMatch(/\.new-session \.composer-box \.composer-input \{ font-size/);
    // A conversation's message text, and only it, is scaled: the one prose size and the code block's label.
    const markdown = read('styles/markdown.css');
    expect(markdown).toContain('.kestrel .chat-text { --prose-size: calc(var(--prose-base) * var(--chat-text-scale, 1)); }');
    expect(markdown).toContain('.kestrel .chat-text .code-lang { font-size: calc(11px * var(--chat-text-scale, 1)); }');
    expect(markdown).not.toMatch(/\.kestrel \.prose \{[^}]*--chat-text-scale/);
  });

  it('draws the terminal in the app’s greys, with full black or white text at high contrast', () => {
    expect(terminalColors(true, 'standard')).toMatchObject({ background: '#1c1c1d', foreground: '#e6e6e6' });
    expect(terminalColors(false, 'high')).toMatchObject({ background: '#fafafa', foreground: '#000000' });
  });
});
