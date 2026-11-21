// The files attached in a composer, as tiles inside the message box above the text. They can be
// dragged into another order (the app's one reorder helper, sidebarDrag.ts), removed, retried, and
// a picture opens large in the viewer.
import { useMemo } from 'react';
import { ATTACHMENT_MIME } from '../../labels.ts';
import { useViewer } from '../PictureViewer.tsx';
import { startDrag, useReorderTarget } from '../sidebarDrag.ts';
import type { PictureRef } from '../useBlobUrl.ts';
import { AttachmentTile } from './AttachmentTile.tsx';
import { draftFiles, type DraftFile } from './draftStore.ts';

function DraftTile({ draftKey, file, onOpen }: { draftKey: string; file: DraftFile; onOpen?: (el: HTMLElement) => void }) {
  const target = useReorderTarget(ATTACHMENT_MIME, (moving, after) => draftFiles.move(draftKey, moving, file.key, after), 'x');
  const picture: PictureRef | undefined = file.preview ? { sessionId: '', kind: 'local', name: file.preview, alt: file.name } : undefined;
  return (
    <AttachmentTile
      name={file.name}
      size={file.size}
      picture={picture}
      status={file.status}
      error={file.error}
      onOpen={onOpen}
      onRemove={() => draftFiles.remove(draftKey, file.key)}
      onRetry={file.retryable ? () => draftFiles.retry(draftKey, file.key) : undefined}
      drag={{ draggable: true, onDragStart: startDrag(ATTACHMENT_MIME, file.key), ...target.props }}
      edge={target.edge}
    />
  );
}

export function DraftTiles({ draftKey, files }: { draftKey: string; files: readonly DraftFile[] }) {
  const pictures = useMemo<PictureRef[]>(() => files.filter((f) => f.preview).map((f) => ({ sessionId: '', kind: 'local', name: f.preview!, alt: f.name })), [files]);
  const { open, viewer } = useViewer(pictures);
  if (files.length === 0) return null;
  return (
    <div className="att-tiles" role="group" aria-label={`${files.length} attached ${files.length === 1 ? 'file' : 'files'}`}>
      {files.map((f) => {
        const at = f.preview ? pictures.findIndex((p) => p.name === f.preview) : -1;
        return <DraftTile key={f.key} draftKey={draftKey} file={f} onOpen={at >= 0 ? (el) => open(at, el) : undefined} />;
      })}
      {viewer}
    </div>
  );
}
