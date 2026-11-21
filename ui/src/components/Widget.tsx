// Something the agent drew (an SVG, or a small HTML page), shown in a sandboxed frame that
// takes the app's colours, sizes itself to its content, and can send a reply with sendPrompt().
import { onAppearance } from '../appearance.ts';
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { WidgetCard } from '@kestrel/server/model';

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 900;
const TOKENS = { fg: '--s-ink', muted: '--s-muted', bg: '--s-bg', border: '--s-line', accent: '--s-accent' } as const;
type Theme = Record<keyof typeof TOKENS, string>;

/** The tokens as plain colours. They are `light-dark()` values, so they are resolved through a probe element. */
function readTheme(root: Element): Theme {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  root.appendChild(probe);
  const out = {} as Theme;
  for (const [name, token] of Object.entries(TOKENS) as [keyof Theme, string][]) {
    probe.style.color = `var(${token})`;
    out[name] = getComputedStyle(probe).color;
  }
  probe.remove();
  return out;
}

/** The app's colours, read again when the system switches between light and dark. */
function useTheme(ref: RefObject<HTMLElement | null>): Theme | null {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const read = () => {
      const el = ref.current;
      if (el) setTheme(readTheme(el.closest('.kestrel') ?? document.documentElement));
    };
    read();
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', read);
    // A theme or contrast chosen in Settings changes the colours without the system changing.
    const stop = onAppearance(read);
    return () => (query.removeEventListener('change', read), stop());
  }, [ref]);
  return theme;
}

// Runs before the agent's code, so sendPrompt exists when its scripts do.
const BRIDGE = `<script>(function(){
var post=function(m){parent.postMessage(m,'*')};
window.sendPrompt=function(t){post({kestrel:'prompt',text:String(t)})};
var report=function(){post({kestrel:'height',height:Math.ceil(document.documentElement.getBoundingClientRect().height)})};
new ResizeObserver(report).observe(document.documentElement,{box:'border-box'});
addEventListener('load',report);
})();</script>`;

function documentFor(code: string, t: Theme): string {
  const vars = `--fg:${t.fg};--muted:${t.muted};--bg:${t.bg};--border:${t.border};--accent:${t.accent};`;
  // No scroll bar: the frame grows to its content, and a bar that takes width makes a scaled SVG
  // shorter, then taller again without it, leaving a bar beside it. Controls use the app's ink.
  const style = `<style>:root{${vars}color-scheme:light dark;color:var(--fg);background:transparent;scrollbar-width:none;accent-color:var(--accent)}html,body{margin:0;background:transparent}body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}body>svg{display:block;max-width:100%;height:auto}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8">${style}${BRIDGE}</head><body>${code}</body></html>`;
}

interface FrameMessage {
  kestrel?: unknown;
  height?: unknown;
  text?: unknown;
}

/** Listens to its own frame only: height reports, and replies sent with sendPrompt(). */
function useFrameMessages(frame: RefObject<HTMLIFrameElement | null>, onHeight: (h: number) => void, onPrompt: (text: string) => void) {
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = (e.data ?? {}) as FrameMessage;
      if (data.kestrel === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) onHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, data.height)));
      else if (data.kestrel === 'prompt' && typeof data.text === 'string' && data.text.trim()) onPrompt(data.text.trim());
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [frame, onHeight, onPrompt]);
}

export const WidgetView = memo(function WidgetView({ widget, onPrompt }: { widget: WidgetCard; onPrompt: (text: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useTheme(box);
  const [height, setHeight] = useState(MIN_HEIGHT * 4);
  // Laid out but hidden until the frame reports its height, so it never flashes an empty block.
  const [measured, setMeasured] = useState(false);
  const prompt = useRef(onPrompt);
  prompt.current = onPrompt;
  const [onSend] = useState(() => (text: string) => prompt.current(text));
  const [onHeight] = useState(() => (h: number) => {
    setHeight(h);
    setMeasured(true);
  });
  useFrameMessages(frame, onHeight, onSend);
  const doc = useMemo(() => (theme ? documentFor(widget.code, theme) : null), [widget.code, theme]);
  return (
    <figure className="widget-card" ref={box}>
      {widget.title && <figcaption>{widget.title}</figcaption>}
      {doc && <iframe ref={frame} title={widget.title || 'Widget'} sandbox="allow-scripts" srcDoc={doc} style={{ height, visibility: measured ? 'visible' : 'hidden' }} />}
    </figure>
  );
});
