// One picture, small, as a button that opens the viewer. The picture is not draggable: a click on a
// trackpad moves the pointer a pixel or two, and a draggable <img> takes that as the start of a drag
// and never sends the click (why pressing a screenshot used to do nothing).
import { memo } from 'react';
import { ImageOff } from 'lucide-react';
import { useBlobUrl, type PictureRef } from './useBlobUrl.ts';
import { pictureLabel } from './PictureViewer.tsx';

interface Props {
  picture: PictureRef;
  /** Show nothing if it cannot be loaded (a preview that is a bonus). */
  quiet?: boolean;
  className?: string;
  onOpen: (opener: HTMLElement) => void;
}

export const ThumbButton = memo(function ThumbButton({ picture, quiet, className, onOpen }: Props) {
  const { url, failed } = useBlobUrl(picture.sessionId, picture.kind, picture.name);
  const label = pictureLabel(picture);
  const classes = `thumb${className ? ` ${className}` : ''}`;
  if (failed && quiet) return null;
  if (failed)
    return (
      <span className={`${classes} thumb-missing`} title={`Could not load ${label}`}>
        <ImageOff aria-hidden />
      </span>
    );
  if (!url) return quiet ? null : <span className={`${classes} thumb-loading`} aria-label={`Loading ${label}`} />;
  return (
    <button type="button" className={classes} aria-label={`Open ${label}`} onClick={(e) => onOpen(e.currentTarget)} onDragStart={(e) => e.preventDefault()}>
      <img src={url} alt={label} draggable={false} />
    </button>
  );
});
