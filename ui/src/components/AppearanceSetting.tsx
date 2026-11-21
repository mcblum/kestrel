// Settings → Appearance (server: shared/appearance.ts; ui/src/appearance.ts): the theme,
// the code font, the terminal's text size, higher contrast for code, and the diff colours. Kept in
// this browser, so each change shows at once and nothing is saved to the server.
import { useState } from 'react';
import { CODE_FONTS, codeFontProblem, DIFF_LABEL, MAX_TERMINAL_FONT, MIN_TERMINAL_FONT, THEME_LABEL, type DiffColors, type Theme } from '@kestrel/server/appearance';
import { setAppearance, useAppearance } from '../appearance.ts';
import { SettingSection } from './SettingHelp.tsx';

const CUSTOM = '__custom__';
const SAMPLE = 'const total = items.reduce((sum, item) => sum + item.price, 0); // 0O 1lI';

function Controls() {
  const look = useAppearance();
  const listed = CODE_FONTS.includes(look.codeFont);
  const [typing, setTyping] = useState(!listed);
  const [typed, setTyped] = useState(listed ? '' : look.codeFont);
  const problem = codeFontProblem(typed.trim());
  return (
    <div className="appearance">
      <label htmlFor="appearance-theme">Theme</label>
      <select id="appearance-theme" className="form-control" value={look.theme} onChange={(e) => setAppearance({ theme: e.target.value as Theme })}>
        {(Object.keys(THEME_LABEL) as Theme[]).map((theme) => <option key={theme} value={theme}>{THEME_LABEL[theme]}</option>)}
      </select>

      <label htmlFor="appearance-font">Code font</label>
      <div className="appearance-font">
        <select id="appearance-font" className="form-control" value={typing ? CUSTOM : look.codeFont} onChange={(e) => (e.target.value === CUSTOM ? setTyping(true) : (setTyping(false), setAppearance({ codeFont: e.target.value })))}>
          {CODE_FONTS.map((font) => <option key={font} value={font}>{font || 'System monospace'}</option>)}
          <option value={CUSTOM}>Another font…</option>
        </select>
        {typing && (
          <input className="form-control" aria-label="Font name" placeholder="A font installed on this Mac" spellCheck={false} value={typed} aria-invalid={problem !== null} onChange={(e) => (setTyped(e.target.value), codeFontProblem(e.target.value.trim()) === null && setAppearance({ codeFont: e.target.value.trim() }))} />
        )}
      </div>
      {typing && problem && <span className="delegation-limit-problem appearance-wide" role="alert">{problem}</span>}
      <code className="appearance-sample appearance-wide">{SAMPLE}</code>

      <label htmlFor="appearance-terminal">Terminal text size</label>
      <div className="appearance-font">
        <input id="appearance-terminal" className="form-control appearance-number" type="number" min={MIN_TERMINAL_FONT} max={MAX_TERMINAL_FONT} step={1} value={look.terminalFontSize} onChange={(e) => e.target.value !== '' && setAppearance({ terminalFontSize: Number(e.target.value) })} />
        <span className="delegation-limit-default">{MIN_TERMINAL_FONT} to {MAX_TERMINAL_FONT} · default 12</span>
      </div>

      <label htmlFor="appearance-diff">Diff colours</label>
      <select id="appearance-diff" className="form-control" value={look.diffColors} onChange={(e) => setAppearance({ diffColors: e.target.value as DiffColors })}>
        {(Object.keys(DIFF_LABEL) as DiffColors[]).map((diff) => <option key={diff} value={diff}>{DIFF_LABEL[diff]}</option>)}
      </select>

      <label className="tag-rule-switch appearance-wide">
        <input type="checkbox" checked={look.contrast === 'high'} onChange={(e) => setAppearance({ contrast: e.target.checked ? 'high' : 'standard' })} />
        Higher contrast for code and quiet text
      </label>
    </div>
  );
}

const HELP = (
  <p className="settings-help">
    How Kestrel looks in this window; kept on this computer, not with your sessions. The code font is used for code in conversations, diffs and the terminal, and a font that is not installed falls back to the system's. "Blue and orange" draws added lines blue
    and removed lines orange, for anyone who does not tell red from green. Higher contrast darkens (or, in dark, lightens) code colours, quiet text and lines.
  </p>
);

export function AppearanceSetting({ page = false }: { page?: boolean } = {}) {
  return (
    <SettingSection level={page ? 1 : 2} className={page ? "settings-section settings-page-section" : "settings-section"} title="Appearance" help={HELP}>
      <Controls />
    </SettingSection>
  );
}
