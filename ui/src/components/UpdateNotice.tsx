// "Restart to update · Kestrel <ver> is ready": a small toast at the foot of the sidebar, directly
// above Settings, as Shrike and Vireo show theirs. Shown once the packaged app has downloaded an
// update (app/updater.mjs). It never restarts by itself, and Restart waits while any session is
// working, so an update never cuts an agent off mid-turn. Dismissing it only hides it until the
// next launch; the update is also installed when Kestrel quits. With the sidebar hidden the same
// toast floats at the window's bottom-left, lifted above the message box when they would meet.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { UpdateState } from '../store.ts';
import { useApp } from '../store.ts';
import { useTabs } from '../tabsStore.ts';
import { applyPlacement } from './usePopupPlacement.ts';

function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const shell = window.kestrelShell;
    if (!shell?.onUpdate || !shell.updateState) return;
    let live = true;
    void shell.updateState().then((s) => live && s && setState(s));
    const off = shell.onUpdate(setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

// The dismissed version outlives the toast itself: hiding the sidebar moves the toast, and it
// must not come back from a dismissal by moving.
let dismissedVersion: string | null = null;
const dismissListeners = new Set<() => void>();
const dismiss = (version: string) => {
  dismissedVersion = version;
  dismissListeners.forEach((l) => l());
};
const subscribeDismissed = (l: () => void) => (dismissListeners.add(l), () => void dismissListeners.delete(l));
const useDismissed = () => useSyncExternalStore(subscribeDismissed, () => dismissedVersion);

const waitingText = (working: number) => `Waits for ${working === 1 ? 'a working session' : `${working} working sessions`}`;

/** `floating`: the sidebar is hidden, so the toast sits at the window's bottom-left instead. */
export function UpdateNotice({ floating = false }: { floating?: boolean }) {
  const update = useUpdateState();
  const working = useApp((s) => s.workspace?.sessions.filter((v) => v.state === 'running').length ?? 0);
  const dismissed = useDismissed();
  const [restarting, setRestarting] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const shown = update?.status === 'ready' && !!update.version && dismissed !== update.version;
  useClearOfComposer(host, floating && shown);
  if (!shown) return null;

  const restart = async () => {
    setRestarting(true);
    const ok = await window.kestrelShell?.restartToUpdate?.();
    if (!ok) setRestarting(false);
  };
  const waiting = working > 0;
  const ready = `Kestrel ${update.version} is ready`;
  return (
    <div ref={host} className={`update-toast${floating ? ' floating' : ''}`} role="status">
      <button type="button" className="update-restart" disabled={waiting || restarting} title={waiting ? `${ready}. Restart waits until no session is working.` : `${ready}. Restart Kestrel to update.`} onClick={() => void restart()}>
        <RefreshCw aria-hidden />
        <span className="update-lines">
          <span className="update-action">{restarting ? 'Restarting…' : 'Restart to update'}</span>
          <span className="update-detail">{waiting ? waitingText(working) : ready}</span>
        </span>
      </button>
      <button type="button" className="update-dismiss" aria-label="Not now" title="Not now: it installs when you quit" onClick={() => dismiss(update.version!)}>
        <X aria-hidden />
      </button>
    </div>
  );
}

const EDGE = 12;
const GAP = 8;

/**
 * Keeps the floating toast clear of the message box: at the bottom-left corner while the box is
 * further right, else just above the box, and inside the window either way (a tall box in a short
 * window). Follows the window, the box's own size, and the tab.
 */
function useClearOfComposer(host: React.RefObject<HTMLDivElement | null>, active: boolean) {
  const tab = useTabs((v) => v.state.activeId);
  useLayoutEffect(() => {
    const el = host.current;
    if (!active || !el) return;
    const box = document.querySelector<HTMLElement>('.composer-wrap');
    const place = () => {
      const r = box?.getBoundingClientRect();
      const meets = r !== undefined && r.width > 0 && r.left < EDGE + el.offsetWidth + GAP;
      // Hung above a point at the left edge: the box's top, or the window's bottom corner.
      const y = meets ? r.top : window.innerHeight - EDGE + GAP;
      applyPlacement(el, { anchor: { left: EDGE, right: EDGE, top: y, bottom: y }, side: 'above', gap: GAP, margin: EDGE });
    };
    place();
    const observer = new ResizeObserver(place);
    if (box) observer.observe(box);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [host, active, tab]);
}
