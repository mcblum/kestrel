// The one button that hides the sidebar and shows it again. It stands in one fixed place on the
// window's top line whether the sidebar is shown or hidden, so the pointer never has to move to
// undo it: on the Mac just right of the traffic lights, elsewhere (and in full screen, where the
// Mac hides the lights) at the far left (`.window-toggle` in organize.css). ⌘B and the View menu
// do the same; the choice is remembered with the sidebar's width. In a window too narrow for the
// sidebar it is drawn as a rail, and this button opens the full sidebar over the content instead
// (sidebarRail.ts); that is not remembered.
import { useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { toggleSidebarOrFloat, useSidebarFloating, useSidebarMode } from '../sidebarRail.ts';

export function SidebarToggle() {
  const mode = useSidebarMode();
  const floating = useSidebarFloating();
  const shown = mode === 'full' || (mode === 'rail' && floating);
  const label = shown ? 'Hide sidebar' : 'Show sidebar';
  return (
    <button className="icon-button sidebar-toggle window-toggle" aria-label={label} aria-expanded={mode === 'rail' ? floating : undefined} title={`${label} ⌘B`} onClick={toggleSidebarOrFloat}>
      {shown ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
    </button>
  );
}

/** Whether the Electron window is full screen; always false in a browser. */
export function useFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.kestrelShell?.onFullScreen?.(setFullScreen), []);
  return fullScreen;
}
