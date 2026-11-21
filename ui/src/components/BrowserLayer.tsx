// The layer every scope's browser page lives in (browserLayer.ts), mounted once at the app's root
// so no page is lost when the page or tab in front changes. Only the desktop app has pages.
import { useEffect, useRef } from 'react';
import { browserLayer } from '../browserLayer.ts';
import { hasBrowserPane } from '../browserStore.ts';

export function BrowserLayer() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    return browserLayer.mount(el.current);
  }, []);
  return hasBrowserPane ? <div className="browser-layer" ref={el} /> : null;
}
