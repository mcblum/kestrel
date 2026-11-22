// The one button that hides the sidebar and shows it again. It stands in one fixed place on the
// window's top line whether the sidebar is shown or hidden, so the pointer never has to move to
// undo it: on the Mac just right of the traffic lights, elsewhere (and in full screen, where the
// Mac hides the lights) at the far left (`.window-toggle` in organize.css). ⌘B and the View menu
// do the same; the choice is remembered with the sidebar's width. In a window too narrow for the
// sidebar it is drawn as a rail, and this button opens the full sidebar over the content instead
// (sidebarRail.ts); that is not remembered.
//
// Back and Forward stand beside it, in the same fixed place (0.0.23): a browser's two buttons, for
// where the user has been in this window (navHistory.ts). Each is dimmed when there is nowhere to
// go that way. The keys are the commands `back` and `forward` (shared/shortcuts.ts).
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { bindingFor, formatBinding } from '@kestrel/server/shortcuts';
import { goBack, goForward, useCanGoBack, useCanGoForward } from '../navHistory.ts';
import { isMac, useShortcuts } from '../shortcuts.ts';
import { toggleSidebarOrFloat, useSidebarFloating, useSidebarMode } from '../sidebarRail.ts';

export function SidebarToggle() {
  const mode = useSidebarMode();
  const floating = useSidebarFloating();
  const shown = mode === 'full' || (mode === 'rail' && floating);
  const label = shown ? 'Hide sidebar' : 'Show sidebar';
  const keys = useShortcuts();
  const key = (command: string) => formatBinding(bindingFor(keys, command), isMac());
  const tip = (what: string, command: string) => [what, key(command)].filter(Boolean).join(' ');
  const canBack = useCanGoBack();
  const canForward = useCanGoForward();
  return (
    <>
      <button className="icon-button sidebar-toggle window-toggle" aria-label={label} aria-expanded={mode === 'rail' ? floating : undefined} title={tip(label, 'toggle-sidebar')} onClick={toggleSidebarOrFloat}>
        {shown ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
      </button>
      <button className="icon-button window-toggle window-nav window-nav-back" aria-label="Back" title={tip('Back', 'back')} disabled={!canBack} onClick={goBack}>
        <ArrowLeft aria-hidden />
      </button>
      <button className="icon-button window-toggle window-nav window-nav-forward" aria-label="Forward" title={tip('Forward', 'forward')} disabled={!canForward} onClick={goForward}>
        <ArrowRight aria-hidden />
      </button>
    </>
  );
}

/** Whether the Electron window is full screen; always false in a browser. */
export function useFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.kestrelShell?.onFullScreen?.(setFullScreen), []);
  return fullScreen;
}
