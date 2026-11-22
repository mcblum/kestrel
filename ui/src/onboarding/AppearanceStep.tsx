// Setup's Appearance step (0.0.23): dark, light, or as the system is set, as three choices that
// take effect as they are picked (the same setting as Settings → Appearance: ui/src/appearance.ts,
// kept in this browser). Dark is the choice until the user makes one, so on arriving here with
// nothing chosen yet the window goes dark, and what is selected is what is on screen.
import { useEffect } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { SETUP_THEME, SETUP_THEME_NOTE, SETUP_THEMES, THEME_LABEL, type Theme } from '@kestrel/server/appearance';
import { appearanceChosen, setAppearance, useAppearance } from '../appearance.ts';

const ICON: Record<Theme, typeof Moon> = { dark: Moon, light: Sun, system: Monitor };

export function AppearanceStep() {
  const { theme } = useAppearance();
  useEffect(() => {
    if (!appearanceChosen()) setAppearance({ theme: SETUP_THEME });
  }, []);
  return <div className="setup-appearance">
    <div className="setup-themes" role="radiogroup" aria-label="Theme">
      {SETUP_THEMES.map((id) => {
        const Icon = ICON[id];
        return <label key={id} className={`setup-theme${theme === id ? ' is-chosen' : ''}`}>
          <input type="radio" name="setup-theme" value={id} checked={theme === id} onChange={() => setAppearance({ theme: id })} />
          <span className="setup-icon"><Icon aria-hidden /></span>
          <span className="setup-theme-text"><strong>{THEME_LABEL[id]}</strong><small>{SETUP_THEME_NOTE[id]}</small></span>
        </label>;
      })}
    </div>
    <p className="form-note">You can change this later in Settings → Appearance, with the code font and diff colours.</p>
  </div>;
}
