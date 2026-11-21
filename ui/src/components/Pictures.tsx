// Pictures in the conversation. One picture is a thumbnail; several that arrived together are a
// group (PictureGroup.tsx). Either opens the viewer (PictureViewer.tsx) over the conversation.
import { useMemo } from 'react';
import { ThumbButton } from './Thumb.tsx';
import { PictureGroup } from './PictureGroup.tsx';
import { useViewer } from './PictureViewer.tsx';
import type { BlobKind, PictureRef } from './useBlobUrl.ts';

/** One picture, small; a click opens it in the viewer as a group of one. `quiet`: show nothing if it cannot be loaded. */
export function Thumb({ sessionId, kind, name, alt, quiet }: { sessionId: string; kind: BlobKind; name: string; alt?: string; quiet?: boolean }) {
  const pictures = useMemo<PictureRef[]>(() => [{ sessionId, kind, name, alt }], [sessionId, kind, name, alt]);
  const { open, viewer } = useViewer(pictures);
  return (
    <>
      <ThumbButton picture={pictures[0]!} quiet={quiet} onOpen={(el) => open(0, el)} />
      {viewer}
    </>
  );
}

/**
 * Pictures a tool returned, from the session's media folder, or (`kind: 'attachment'`, by id) ones
 * the user attached. `caption`: what the viewer says about them all; `captions`: about each.
 */
export function Pictures({ sessionId, images, caption, captions: each, kind = 'media' }: { sessionId: string; images: readonly string[]; caption?: string; captions?: readonly string[]; kind?: BlobKind }) {
  const captions = useMemo(() => each ?? images.map(() => caption ?? ''), [images, caption, each]);
  if (images.length === 1)
    return (
      <div className="thumb-row">
        <Thumb sessionId={sessionId} kind={kind} name={images[0]!} alt={captions[0] || undefined} />
      </div>
    );
  return <PictureGroup sessionId={sessionId} images={images} captions={captions} kind={kind} />;
}
