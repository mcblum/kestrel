// One attached file as a tile: a picture cover-fitted, any other file as an icon with its name
// (two lines at most, shortened in the middle) and size. Used in the composer (with remove and
// retry, and the upload's state on the tile), in a queued message (`small`), and in a sent one.
import type { DragEvent, ReactNode } from 'react';
import { FileText, ImageOff, RotateCw, X } from 'lucide-react';
import { formatSize, middleEllipsis } from '@kestrel/server/attachments';
import { useBlobUrl, type PictureRef } from '../useBlobUrl.ts';

/** How tall a tile is in the composer, and in a queued message. */
export const TILE_HEIGHT = 104;
export const SMALL_TILE_HEIGHT = 64;
const NAME_CHARS = 40;

export interface TileProps {
  name: string;
  size: number;
  /** A picture to show, when the file is one. */
  picture?: PictureRef;
  status?: 'uploading' | 'ready' | 'error';
  error?: string;
  small?: boolean;
  /** Opens the picture large; absent for a file (or a picture not loaded). */
  onOpen?: (opener: HTMLElement) => void;
  /** Shows where the file came from; absent when that is not known. */
  onReveal?: () => void;
  onRemove?: () => void;
  onRetry?: () => void;
  /** Drag-to-reorder: the tile's drag and drop handlers, and where the drop line shows. */
  drag?: { draggable: true; onDragStart: (e: DragEvent) => void } & Record<string, unknown>;
  edge?: 'before' | 'after' | null;
}

function Face({ name, size, picture, onOpen, onReveal }: Pick<TileProps, 'name' | 'size' | 'picture' | 'onOpen' | 'onReveal'>) {
  const { url, failed } = useBlobUrl(picture?.sessionId ?? '', picture?.kind ?? 'local', picture?.name ?? '', Boolean(picture));
  if (picture && url) {
    const img = <img src={url} alt={name} draggable={false} />;
    return onOpen ? <button type="button" className="att-face" aria-label={`Open ${name}`} title={name} onClick={(e) => onOpen(e.currentTarget)}>{img}</button> : <span className="att-face">{img}</span>;
  }
  const label = (
    <>
      {picture && failed ? <ImageOff aria-hidden /> : <FileText aria-hidden />}
      <span className="att-name">{middleEllipsis(name, NAME_CHARS)}</span>
      <span className="att-size">{formatSize(size)}</span>
    </>
  );
  // A file opens nothing in the app; where its original is known, it can be shown in Finder.
  return onReveal ? <button type="button" className="att-face att-file" title={`Show ${name} in Finder`} onClick={onReveal}>{label}</button> : <span className="att-face att-file" title={name}>{label}</span>;
}

export function AttachmentTile(props: TileProps) {
  const { status, error, small, onRemove, onRetry, drag, edge, picture } = props;
  const state = status === 'uploading' ? ' att-uploading' : status === 'error' ? ' att-error' : '';
  const shape = picture && status !== 'error' ? ' att-image' : ' att-doc';
  let overlay: ReactNode = null;
  if (status === 'uploading') overlay = <span className="att-progress" role="status" aria-label={`Uploading ${props.name}`} />;
  if (status === 'error')
    overlay = (
      <span className="att-problem" role="alert" title={error}>
        <span className="att-name">{middleEllipsis(props.name, NAME_CHARS)}</span>
        <span className="att-problem-text">{error}</span>
        {onRetry && (
          <button type="button" className="att-retry" onClick={onRetry} aria-label={`Retry ${props.name}`}>
            <RotateCw aria-hidden /> Retry
          </button>
        )}
      </span>
    );
  return (
    <div className={`att-tile${small ? ' att-small' : ''}${shape}${state}${edge ? ` drop-${edge}` : ''}`} {...drag}>
      {status !== 'error' && <Face {...props} />}
      {overlay}
      {onRemove && (
        <button type="button" className="att-remove" aria-label={`Remove ${props.name}`} title="Remove" onClick={onRemove}>
          <X aria-hidden />
        </button>
      )}
    </div>
  );
}
