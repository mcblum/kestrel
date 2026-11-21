// Several pictures that arrived together (shared/conversation-folds.ts), as one compact strip: the first
// few, then "+N" for the rest, and a count. Any of them opens the viewer at that picture, over all
// of them. Only the pictures in the strip are fetched until the viewer asks for more.
import { memo, useMemo } from 'react';
import { Images } from 'lucide-react';
import { ThumbButton } from './Thumb.tsx';
import { useViewer } from './PictureViewer.tsx';
import type { BlobKind, PictureRef } from './useBlobUrl.ts';

/** Thumbnails shown before the rest become "+N". */
export const GROUP_SHOWN = 5;

const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** `images`: file names under the session's media folder, in order; `captions`: what the viewer says about each. */
export const PictureGroup = memo(
  function PictureGroup({ sessionId, images, captions, kind = 'media' }: { sessionId: string; images: readonly string[]; captions?: readonly string[]; kind?: BlobKind }) {
    const pictures = useMemo<PictureRef[]>(() => images.map((name, i) => ({ sessionId, kind, name, alt: captions?.[i] || undefined })), [sessionId, images, captions, kind]);
    const { open, viewer } = useViewer(pictures);
    // Exactly one more than fits would be "+1": show it instead.
    const shown = pictures.length <= GROUP_SHOWN + 1 ? pictures : pictures.slice(0, GROUP_SHOWN);
    const rest = pictures.length - shown.length;
    return (
      <div className="picture-group" role="group" aria-label={`${pictures.length} pictures`}>
        <div className="picture-group-head">
          <Images aria-hidden />
          {pictures.length} pictures
        </div>
        <div className="picture-group-strip">
          {shown.map((p, i) => (
            <ThumbButton key={p.name} picture={p} className="group-thumb" onOpen={(el) => open(i, el)} />
          ))}
          {rest > 0 && (
            <button type="button" className="thumb group-thumb group-more" aria-label={`Open the other ${rest} pictures`} onClick={(e) => open(shown.length, e.currentTarget)}>
              +{rest}
            </button>
          )}
        </div>
        {viewer}
      </div>
    );
  },
  // Rebuilt lists with the same pictures do not redraw the strip.
  (a, b) => a.sessionId === b.sessionId && a.kind === b.kind && same(a.images, b.images) && same(a.captions, b.captions),
);
