// A scope's browser (a session's, a project page's, a group page's): one line of controls (back,
// forward, reload, the address, open in your own browser) over the page. The user browses in it
// and a session's agent drives it through Kestrel's browser tools, so the user sees what the agent
// does. The page itself lives in the window's browser layer (browserLayer.ts) and outlives this
// pane: the pane only marks where it goes. Outside the desktop app there is no <webview>, and the
// pane says so.
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PaneClose, PaneHead } from './PaneHead.tsx';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import { addressFromInput, checkBrowserUrl, NEEDS_DESKTOP } from '@kestrel/server/browser';
import type { WebviewHost } from '../browserHost.ts';
import { browserLayer } from '../browserLayer.ts';
import { browserGuard, browserPane, hasBrowserPane, useBrowserView } from '../browserStore.ts';

/** The pane. Hidden (not unmounted) while it is off; its page stays alive either way. */
export function BrowserView({ scopeKey, visible }: { scopeKey: string; visible: boolean }) {
  return (
    <div className="browser-content">
      {hasBrowserPane ? (
        <BrowserPane scopeKey={scopeKey} visible={visible} />
      ) : (
        <>
          {/* No address bar outside the desktop app, so the pane gets a plain head for its X. */}
          <PaneHead pane="browser" name="Browser" />
          <p className="browser-empty">{NEEDS_DESKTOP}</p>
        </>
      )}
    </div>
  );
}

function BrowserPane({ scopeKey, visible }: { scopeKey: string; visible: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  const placed = useRef<ReturnType<typeof browserLayer.slot> | null>(null);
  const [controls, setControls] = useState<BarControls | null>(null);
  const hasPage = useBrowserView(scopeKey).url !== '';

  // The scope's page, made once for the window; this pane marks where it shows.
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    setControls(barControls(browserLayer.host(scopeKey)));
    const mark = browserLayer.slot(scopeKey, el);
    placed.current = mark;
    return () => {
      placed.current = null;
      mark.remove();
    };
  }, [scopeKey]);

  // Every render may have moved the slot (a column opened, a divider dragged): lay the page over it again.
  useLayoutEffect(() => {
    placed.current?.update(visible);
  });

  return (
    <div className="browser-view">
      <AddressBar sessionId={scopeKey} host={controls} />
      <div className="browser-page">
        <div className="browser-host" ref={slot} />
        {!hasPage && <p className="browser-empty">Type an address above.</p>}
      </div>
    </div>
  );
}

/**
 * What the bar does to the page, as functions only. The WebviewHost itself is never a prop: React's
 * development build walks changed props to log them, reaches the <webview>'s own `contentWindow`
 * (another origin), throws a SecurityError mid-commit and stops rendering the whole window.
 */
interface BarControls {
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  open(url: string): Promise<unknown>;
}
// The host can be replaced when the window closes a page to save memory: ask for the current one each time.
const barControls = (first: WebviewHost): BarControls => {
  const key = first.key;
  const host = () => browserLayer.existing(key) ?? first;
  return { back: () => host().back(), forward: () => host().forward(), reloadOrStop: () => host().reloadOrStop(), open: (url) => host().open(url) };
};

const AddressBar = memo(function AddressBar({ sessionId, host }: { sessionId: string; host: BarControls | null }) {
  const view = useBrowserView(sessionId);
  const [draft, setDraft] = useState<string | null>(null);
  const justFocused = useRef(false);
  const field = useRef<HTMLInputElement>(null);

  const go = (input: string) => {
    const address = addressFromInput(input);
    if (!address || !host) return;
    const checked = checkBrowserUrl(address, browserGuard());
    if (!checked.ok) {
      // Keep what was typed, selected, so the next keystroke replaces it.
      field.current?.select();
      return browserPane.setView(sessionId, { note: checked.reason });
    }
    setDraft(null);
    field.current?.blur();
    host.open(checked.url).catch(() => undefined); // a failure shows as the note under the bar
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') go(e.currentTarget.value);
    else if (e.key === 'Escape') {
      setDraft(null);
      e.currentTarget.blur();
    }
  };

  return (
    <>
      <div className="browser-bar">
        <button type="button" className="browser-button" aria-label="Back" disabled={!view.canGoBack} onClick={host?.back}>
          <ArrowLeft aria-hidden />
        </button>
        <button type="button" className="browser-button" aria-label="Forward" disabled={!view.canGoForward} onClick={host?.forward}>
          <ArrowRight aria-hidden />
        </button>
        <button type="button" className="browser-button" aria-label={view.loading ? 'Stop loading' : 'Reload'} disabled={!view.url} onClick={host?.reloadOrStop}>
          {view.loading ? <X aria-hidden /> : <RotateCw aria-hidden />}
        </button>
        <label className="browser-address">
          <Globe aria-hidden />
          <input
            ref={field}
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Address"
            value={draft ?? view.url}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              justFocused.current = true;
              e.currentTarget.select();
            }}
            onMouseUp={(e) => {
              // The click that focused the field would otherwise undo select-all.
              if (justFocused.current) e.preventDefault();
              justFocused.current = false;
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={onKeyDown}
          />
        </label>
        <button type="button" className="browser-button" aria-label="Open in your browser" disabled={!view.url} onClick={() => view.url && window.open(view.url, '_blank', 'noopener')}>
          <ExternalLink aria-hidden />
        </button>
        <PaneClose pane="browser" name="Browser" />
        <div className="browser-progress" hidden={!view.loading} />
      </div>
      {view.note && <p className="browser-note">{view.note}</p>}
    </>
  );
});
