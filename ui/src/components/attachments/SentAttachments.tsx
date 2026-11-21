// The files on a message that has gone (or waits in the queue): pictures through the conversation's
// own pictures (Pictures.tsx, opening the viewer), other files as tiles. `small` for a queued message,
// where pictures are small tiles too.
import { useMemo } from 'react';
import type { Attachment } from '@kestrel/server/model';
import { actions } from '../../store.ts';
import { useViewer } from '../PictureViewer.tsx';
import { Pictures } from '../Pictures.tsx';
import type { PictureRef } from '../useBlobUrl.ts';
import { AttachmentTile } from './AttachmentTile.tsx';

function FileTiles({ files, small }: { files: readonly Attachment[]; small?: boolean }) {
  return (
    <>
      {files.map((a) => (
        <AttachmentTile key={a.id} name={a.name} size={a.size} small={small} onReveal={a.path ? () => void actions.reveal(a.path!) : undefined} />
      ))}
    </>
  );
}

function SmallTiles({ sessionId, attachments }: { sessionId: string; attachments: readonly Attachment[] }) {
  const pictures = useMemo<PictureRef[]>(() => attachments.filter((a) => a.kind === 'image').map((a) => ({ sessionId, kind: 'attachment', name: a.id, alt: a.name })), [sessionId, attachments]);
  const { open, viewer } = useViewer(pictures);
  return (
    <div className="att-tiles att-tiles-small">
      {attachments.map((a) => {
        const at = pictures.findIndex((p) => p.name === a.id);
        if (at < 0) return <FileTiles key={a.id} files={[a]} small />;
        return <AttachmentTile key={a.id} name={a.name} size={a.size} small picture={pictures[at]} onOpen={(el) => open(at, el)} />;
      })}
      {viewer}
    </div>
  );
}

export function SentAttachments({ sessionId, attachments, small }: { sessionId: string; attachments: readonly Attachment[]; small?: boolean }) {
  const images = useMemo(() => attachments.filter((a) => a.kind === 'image'), [attachments]);
  const ids = useMemo(() => images.map((a) => a.id), [images]);
  const names = useMemo(() => images.map((a) => a.name), [images]);
  if (attachments.length === 0) return null;
  if (small) return <SmallTiles sessionId={sessionId} attachments={attachments} />;
  const files = attachments.filter((a) => a.kind !== 'image');
  return (
    <div className="att-sent">
      {images.length > 0 && <Pictures sessionId={sessionId} images={ids} captions={names} kind="attachment" />}
      {files.length > 0 && (
        <div className="att-tiles">
          <FileTiles files={files} />
        </div>
      )}
    </div>
  );
}
