// A PDF, page under page, drawn by pdf.js (Mozilla's renderer; Kestrel writes none of its own). Only
// the pages near the screen are drawn, each at the screen's pixel density, with its text laid over
// it so it can be selected and copied. The pages fit the tab's width up to a comfortable limit;
// the buttons zoom from there.
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, RenderingCancelledException, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** The widest a page is drawn before zooming, and the room kept either side of it. */
const FIT_MAX_WIDTH = 900;
const SIDE_ROOM = 48;
const ZOOM = { min: 0.5, max: 3, step: 0.25 } as const;
/** How far off screen a page starts being drawn. */
const NEAR = '800px';
/** A4, until a page says what shape it is. */
const DEFAULT_RATIO = 297 / 210;

type Opened = { state: 'opening' } | { state: 'failed'; reason: string } | { state: 'open'; doc: PDFDocumentProxy; ratio: number };

function useDocument(data: Uint8Array): Opened {
  const [opened, setOpened] = useState<Opened>({ state: 'opening' });
  useEffect(() => {
    let current = true;
    setOpened({ state: 'opening' });
    // pdf.js hands the bytes to its worker, so it gets a copy and the tab keeps its own.
    const task = getDocument({ data: data.slice() });
    task.promise
      .then(async (doc) => {
        const first = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (current) setOpened({ state: 'open', doc, ratio: first.height / first.width });
      })
      .catch((error: unknown) => current && setOpened({ state: 'failed', reason: error instanceof Error && error.name === 'PasswordException' ? 'This PDF needs a password, so it is not shown here.' : 'This file could not be read as a PDF.' }));
    return () => {
      current = false;
      void task.destroy();
    };
  }, [data]);
  return opened;
}

export default function PdfPages({ data }: { data: Uint8Array }) {
  const opened = useDocument(data);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(() => setRoom(scroller.clientWidth));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  if (opened.state === 'opening') return <p className="file-document-note">Loading…</p>;
  if (opened.state === 'failed') return <p className="file-document-note">{opened.reason}</p>;
  const { doc, ratio } = opened;
  const width = Math.round(Math.max(120, Math.min(FIT_MAX_WIDTH, room - SIDE_ROOM)) * zoom);
  const step = (by: number) => setZoom((z) => Math.min(ZOOM.max, Math.max(ZOOM.min, z + by)));
  return (
    <>
      <div className="pdf-bar" role="toolbar" aria-label="PDF">
        <span>
          {doc.numPages.toLocaleString()} {doc.numPages === 1 ? 'page' : 'pages'}
        </span>
        <span className="pdf-zoom">
          <button type="button" className="copy-button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= ZOOM.min} onClick={() => step(-ZOOM.step)}>
            <Minus aria-hidden />
          </button>
          <button type="button" className="pdf-zoom-level" title="Fit the width" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className="copy-button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= ZOOM.max} onClick={() => step(ZOOM.step)}>
            <Plus aria-hidden />
          </button>
        </span>
      </div>
      <div className="pdf-pages" ref={setScroller} tabIndex={0} aria-label="Pages">
        {room > 0 && Array.from({ length: doc.numPages }, (_, index) => <PdfPage key={index} doc={doc} number={index + 1} width={width} ratio={ratio} scroller={scroller} />)}
      </div>
    </>
  );
}

function PdfPage({ doc, number, width, ratio: assumed, scroller }: { doc: PDFDocumentProxy; number: number; width: number; ratio: number; scroller: HTMLDivElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(assumed);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!box.current || !scroller) return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { root: scroller, rootMargin: `${NEAR} 0px` });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!near) return;
    let current = true;
    let stop = () => {};
    void (async () => {
      try {
        const page = await doc.getPage(number);
        if (!current || !canvas.current || !text.current) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        const scale = width / base.width;
        const pixels = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
        canvas.current.width = Math.floor(pixels.width);
        canvas.current.height = Math.floor(pixels.height);
        const drawing = page.render({ canvas: canvas.current, viewport: pixels });
        const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport: page.getViewport({ scale }) });
        stop = () => {
          drawing.cancel();
          layer.cancel();
        };
        text.current.replaceChildren();
        text.current.style.setProperty('--total-scale-factor', String(scale));
        await Promise.all([drawing.promise, layer.render()]);
        if (current) setFailed(false);
      } catch (error) {
        // A page scrolled away or resized while it was being drawn is not a failure.
        if (current && !(error instanceof RenderingCancelledException) && !(error instanceof Error && error.name === 'AbortException')) setFailed(true);
      }
    })();
    return () => {
      current = false;
      stop();
    };
  }, [doc, number, width, near]);

  return (
    <div className="pdf-page" ref={box} style={{ width, height: Math.round(width * ratio) }} aria-label={`Page ${number}`}>
      {near && <canvas ref={canvas} />}
      {near && <div className="pdf-text" ref={text} />}
      {failed && <p className="file-document-note">Page {number} could not be drawn.</p>}
    </div>
  );
}
