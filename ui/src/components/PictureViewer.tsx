// The picture viewer: every picture of a group over the conversation (never a side panel), one at
// a time, fitted without distortion. Arrow keys and the buttons move through them, Escape or a
// click on the backdrop closes it, and focus stays inside until it closes, then goes back to the
// thumbnail that opened it. Only the picture shown and its neighbours are fetched; the filmstrip
// fetches a thumbnail once it scrolls into view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';
import { useBlobUrl, type PictureRef } from './useBlobUrl.ts';

/** A file's own name is worth showing; a tool's stored picture (shot-<uuid>-0.jpg) is not. */
const fileName = (p: PictureRef) => (p.kind === 'raw' ? p.name.split('/').at(-1) || '' : '');

/** What a picture is called for people: its caption, a file's name, or just "Picture". */
export const pictureLabel = (p: PictureRef) => p.alt || fileName(p) || 'Picture';

/** The viewer covers the conversation the picture sits in; elsewhere, the window. */
function hostFor(el: HTMLElement): { host: Element; window: boolean } {
  const conversation = el.closest('.conversation');
  if (conversation) return { host: conversation, window: false };
  return { host: el.closest('.kestrel') ?? document.querySelector('.kestrel') ?? document.body, window: true };
}

interface Open {
  index: number;
  opener: HTMLElement;
}

/** Open the viewer over a set of pictures: `open(index, the thumbnail pressed)`; render `viewer` somewhere. */
export function useViewer(pictures: readonly PictureRef[]): { open: (index: number, opener: HTMLElement) => void; viewer: ReactNode } {
  const [state, setState] = useState<Open | null>(null);
  const open = useCallback((index: number, opener: HTMLElement) => setState({ index, opener }), []);
  const close = useCallback(() => setState(null), []);
  const viewer = state && pictures.length > 0 ? <PictureViewer pictures={pictures} start={Math.min(state.index, pictures.length - 1)} opener={state.opener} onClose={close} /> : null;
  return { open, viewer };
}

const FOCUSABLE = 'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

function PictureViewer({ pictures, start, opener, onClose }: { pictures: readonly PictureRef[]; start: number; opener: HTMLElement; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [{ host, window: overWindow }] = useState(() => hostFor(opener));
  const root = useRef<HTMLDivElement>(null);
  const count = pictures.length;
  const go = (to: number) => setIndex(Math.max(0, Math.min(count - 1, to)));

  // Focus moves in, and back to the thumbnail when the viewer goes.
  useEffect(() => {
    root.current?.focus();
    return () => {
      if (opener.isConnected) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const keys: Record<string, () => void> = { Escape: onClose, ArrowRight: () => go(index + 1), ArrowDown: () => go(index + 1), ArrowLeft: () => go(index - 1), ArrowUp: () => go(index - 1), Home: () => go(0), End: () => go(count - 1) };
    const action = keys[e.key];
    if (action) {
      handled();
      return action();
    }
    if (e.key !== 'Tab' || !root.current) return;
    // Tab goes round the viewer's own buttons.
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return handled();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1;
    handled();
    items[next]!.focus();
  };
  // Only a press on the backdrop itself closes; the picture and the controls do not.
  const onBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const current = pictures[index]!;
  return createPortal(
    <div ref={root} className={`viewer${overWindow ? ' viewer-window' : ''}`} role="dialog" aria-modal="true" aria-label={count > 1 ? `Pictures, ${index + 1} of ${count}` : pictureLabel(current)} tabIndex={-1} onKeyDown={onKeyDown} onClick={onBackdrop}>
      <div className="viewer-top" onClick={onBackdrop}>
        {count > 1 && (
          <span className="viewer-count" aria-live="polite">
            {index + 1} of {count}
          </span>
        )}
        {/* Nothing rather than a stored file name. */}
        <span className="viewer-name" title={current.alt || fileName(current) || undefined}>
          {current.alt || fileName(current)}
        </span>
        <button type="button" className="viewer-button" aria-label="Close (Escape)" title="Close (Escape)" onClick={onClose}>
          <X aria-hidden />
        </button>
      </div>
      <div className="viewer-stage" onClick={onBackdrop}>
        {count > 1 && (
          <button type="button" className="viewer-button viewer-step" aria-label="Previous picture (Left arrow)" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeft aria-hidden />
          </button>
        )}
        <div className="viewer-frame" onClick={onBackdrop}>
          <ViewerImage key={`${current.kind}:${current.name}`} picture={current} />
        </div>
        {count > 1 && (
          <button type="button" className="viewer-button viewer-step" aria-label="Next picture (Right arrow)" disabled={index === count - 1} onClick={() => go(index + 1)}>
            <ChevronRight aria-hidden />
          </button>
        )}
      </div>
      {/* The neighbours are fetched ahead, so stepping through does not wait. */}
      {pictures[index - 1] && <Prefetch picture={pictures[index - 1]!} />}
      {pictures[index + 1] && <Prefetch picture={pictures[index + 1]!} />}
      {count > 1 && <Filmstrip pictures={pictures} index={index} onPick={go} />}
    </div>,
    host,
  );
}

function ViewerImage({ picture }: { picture: PictureRef }) {
  const { url, failed } = useBlobUrl(picture.sessionId, picture.kind, picture.name);
  if (failed)
    return (
      <p className="viewer-missing">
        <ImageOff aria-hidden /> Could not load {pictureLabel(picture)}
      </p>
    );
  if (!url) return <span className="viewer-loading" aria-label={`Loading ${pictureLabel(picture)}`} />;
  return <img className="viewer-image" src={url} alt={pictureLabel(picture)} draggable={false} />;
}

function Prefetch({ picture }: { picture: PictureRef }) {
  useBlobUrl(picture.sessionId, picture.kind, picture.name);
  return null;
}

function Filmstrip({ pictures, index, onPick }: { pictures: readonly PictureRef[]; index: number; onPick: (i: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  // Keep the picture shown in view in the strip.
  useLayoutEffect(() => {
    const el = strip.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [index]);
  return (
    <div className="viewer-strip" ref={strip} role="listbox" aria-label="All pictures" aria-orientation="horizontal">
      {pictures.map((p, i) => (
        <FilmThumb key={`${p.kind}:${p.name}`} picture={p} index={i} current={i === index} strip={strip} onPick={onPick} />
      ))}
    </div>
  );
}

function FilmThumb({ picture, index, current, strip, onPick }: { picture: PictureRef; index: number; current: boolean; strip: RefObject<HTMLDivElement | null>; onPick: (i: number) => void }) {
  const el = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const target = el.current;
    if (!target || seen) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { root: strip.current, rootMargin: '0px 120px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [seen, strip]);
  const { url } = useBlobUrl(picture.sessionId, picture.kind, picture.name, seen);
  return (
    <button ref={el} type="button" role="option" aria-selected={current} className={`viewer-film${current ? ' current' : ''}`} aria-label={`Picture ${index + 1}: ${pictureLabel(picture)}`} tabIndex={current ? 0 : -1} onClick={() => onPick(index)}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="viewer-film-empty" />}
    </button>
  );
}
