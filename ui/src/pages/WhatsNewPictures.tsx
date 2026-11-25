// The pictures of the What's new notes, all from `whats-new/images/` beside the notes files, so a
// release brings its own. A photo or screenshot (`.png`, `.jpg`, …) is fetched through the token like
// every picture and drawn as an <img>. A drawing (`.svg`) is put inline in the page instead, so it draws
// in `currentColor` and the page's colours and follows light and dark: the server sends it as sanitized
// markup (never as an SVG document), and `sanitizeSvg` runs again here, just before it is drawn. The
// picture's alt text is its caption.
import { ready, type Sourced } from '@kestrel/server/sourced';
import { NOTES_DRAWING, sanitizeSvg } from '@kestrel/server/whats-new-svg';
import { memo } from 'react';
import type { PictureOf } from '../components/Markdown.tsx';
import { useBlobUrl } from '../components/useBlobUrl.ts';
import { useResource } from '../data/resources.ts';

const nameOf = (src: string) => src.replace(/^\.?\/?images\//, '');

function NotesPicture({ src, alt }: { src: string; alt: string }) {
  const { url, failed } = useBlobUrl('', 'notes', nameOf(src));
  if (failed) return <span className="quiet">{alt}</span>;
  return url ? <img className="whats-new-picture" src={url} alt={alt} /> : null;
}

type Drawing = { name: string; svg: string };
const asDrawing = (raw: unknown): Sourced<Drawing> => ready(raw as Drawing);

const NotesDrawing = memo(function NotesDrawing({ name, caption }: { name: string; caption: string }) {
  const loaded = useResource(`/api/whats-new/drawings/${encodeURIComponent(name)}`, asDrawing).value;
  const markup = loaded.state === 'ready' ? sanitizeSvg(loaded.value.svg) : null;
  // Loading or refused, the caption alone stands in for it, as an <img>'s alt would.
  if (markup === null) return loaded.state === 'loading' ? null : caption ? <p className="quiet">{caption}</p> : null;
  return (
    <figure className="whats-new-drawing" role={caption ? 'img' : undefined} aria-label={caption || undefined} aria-hidden={caption ? undefined : true}>
      {/* Sanitized by sanitizeSvg (shared/whats-new-svg.ts): an allow-list of shapes and attributes, nothing that runs or reaches out. */}
      <div className="whats-new-drawing-art" aria-hidden dangerouslySetInnerHTML={{ __html: markup }} />
      {caption && <figcaption aria-hidden>{caption}</figcaption>}
    </figure>
  );
});

/** How the notes' pictures are drawn, wherever they are on the page. */
export const notesPicture: PictureOf = (src, alt) => {
  const name = nameOf(src);
  return NOTES_DRAWING.test(name) ? <NotesDrawing name={name} caption={alt} /> : <NotesPicture src={src} alt={alt} />;
};
