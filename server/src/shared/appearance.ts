// How Kestrel looks on this computer (0.0.20, matt/kestrel#21): light, dark or the system's; the
// font code is drawn in; the terminal's text size; higher-contrast text for code; and diffs in
// blue and orange for people who do not tell red from green. A preference of the window, kept in
// the browser (ui/src/appearance.ts), not server data. Pure and browser-safe.

export type Theme = 'system' | 'light' | 'dark';
export type Contrast = 'standard' | 'high';
export type DiffColors = 'red-green' | 'blue-orange';

export interface Appearance {
  theme: Theme;
  /** A font family for code, diffs and the terminal; '' for the system's monospace. */
  codeFont: string;
  terminalFontSize: number;
  contrast: Contrast;
  diffColors: DiffColors;
}

export const MIN_TERMINAL_FONT = 9;
export const MAX_TERMINAL_FONT = 24;
export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', codeFont: '', terminalFontSize: 12, contrast: 'standard', diffColors: 'red-green' };

export const THEME_LABEL: Record<Theme, string> = { system: 'Match the system', light: 'Light', dark: 'Dark' };
export const DIFF_LABEL: Record<DiffColors, string> = { 'red-green': 'Green and red', 'blue-orange': 'Blue and orange' };

/** Fonts offered by name; any other installed font can be typed. '' is the system's own. */
export const CODE_FONTS: readonly string[] = ['', 'SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'IBM Plex Mono'];

const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const MAX_FONT_NAME = 60;

/** Why `name` cannot be a font family, or null when it can ('' is the system's). It goes into a style, so only what a font name is made of. */
export function codeFontProblem(name: string): string | null {
  if (!name) return null;
  if (name.length > MAX_FONT_NAME) return `A font name can be at most ${MAX_FONT_NAME} characters.`;
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) ? null : 'A font name is letters, digits, spaces, dots, dashes and underscores.';
}

/** The font stack for code: the chosen font first, then the system's, so a font that is not installed falls back. */
export const codeFontStack = (font: string): string => (font && codeFontProblem(font) === null ? `"${font}", ${SYSTEM_MONO}` : SYSTEM_MONO);

export const clampTerminalFont = (size: number): number => Math.max(MIN_TERMINAL_FONT, Math.min(MAX_TERMINAL_FONT, Math.round(size)));

/** Stored preferences as read back: anything unreadable is the default for that part. */
export function sanitizeAppearance(value: unknown): Appearance {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const font = typeof v.codeFont === 'string' ? v.codeFont.trim() : '';
  return {
    theme: v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system',
    codeFont: codeFontProblem(font) === null ? font : '',
    terminalFontSize: typeof v.terminalFontSize === 'number' && Number.isFinite(v.terminalFontSize) ? clampTerminalFont(v.terminalFontSize) : DEFAULT_APPEARANCE.terminalFontSize,
    contrast: v.contrast === 'high' ? 'high' : 'standard',
    diffColors: v.diffColors === 'blue-orange' ? 'blue-orange' : 'red-green',
  };
}

/** Whether the window is drawn dark: the choice, or the system's when it is left to the system. */
export const isDark = (theme: Theme, systemDark: boolean): boolean => (theme === 'system' ? systemDark : theme === 'dark');

/** What goes on the page's root element: the colour scheme the stylesheets' light-dark() follows, and what the high-contrast and diff rules key on. */
export function rootLook(appearance: Appearance): { colorScheme: string; contrast: Contrast; diff: DiffColors; mono: string } {
  return { colorScheme: appearance.theme === 'system' ? 'light dark' : appearance.theme, contrast: appearance.contrast, diff: appearance.diffColors, mono: codeFontStack(appearance.codeFont) };
}

/** The terminal's own colours: grey surfaces as the app's, xterm's colours for program output. */
export function terminalColors(dark: boolean, contrast: Contrast): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const ink = dark ? (contrast === 'high' ? '#ffffff' : '#e6e6e6') : contrast === 'high' ? '#000000' : '#1f1f1f';
  return { background: dark ? '#1c1c1d' : '#fafafa', foreground: ink, cursor: ink, selectionBackground: dark ? '#4a4a4c' : '#cfcfcf' };
}
