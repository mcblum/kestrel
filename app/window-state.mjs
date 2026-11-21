// Remembers the window's size and position between launches (a small JSON file in userData).
import { app, screen } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT = { width: 1440, height: 900 };
const file = () => join(app.getPath('userData'), 'window-state.json');

/** The saved bounds if they are still on a connected display; otherwise the default size. */
export function loadBounds() {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'));
    const ok = Number.isFinite(saved.width) && Number.isFinite(saved.height) && saved.width >= 600 && saved.height >= 400;
    if (!ok) return DEFAULT;
    const visible = Number.isFinite(saved.x) && Number.isFinite(saved.y) && screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return saved.x + 100 < b.x + b.width && saved.x + saved.width - 100 > b.x && saved.y >= b.y - 20 && saved.y + 100 < b.y + b.height;
    });
    return visible ? saved : { width: saved.width, height: saved.height };
  } catch {
    return DEFAULT;
  }
}

export function trackBounds(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      writeFileSync(file(), JSON.stringify(win.getNormalBounds()));
    } catch {
      // Not being able to remember the size is not worth interrupting anyone for.
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', save);
}
