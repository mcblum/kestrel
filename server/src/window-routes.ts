// Which of the HTTP routes only make sense on a computer with a screen, so a worker node refuses them with the
// reason (shared/no-window.ts) instead of doing something nobody can see. Pure: http.ts asks it before routing.
import type { WindowThing } from './shared/no-window.ts';

/** The window-only thing a request is for, or null when it is an ordinary route. `parts` is the path split on `/`. */
export function windowThingOf(parts: readonly string[], method: string): WindowThing | null {
  if (parts[1] === 'simulator') return 'simulator';
  if (parts[1] === 'whats-new') return 'whats-new';
  if (method !== 'POST') return null;
  if (parts[1] === 'open-folder' && parts.length === 2) return 'open-in';
  if (parts[1] === 'sessions' && (parts[3] === 'open-file' || parts[3] === 'reveal-file')) return 'open-in';
  if (parts[1] === 'projects' && parts[2] === 'list-folder') return 'folder-chooser';
  return null;
}
