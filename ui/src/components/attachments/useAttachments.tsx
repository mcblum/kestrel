// Everything a message box needs for attachments, in one hook: its files (draftStore.ts), the tiles
// inside the box, the paperclip, pasting files, the drop zone over the page, and whether the
// message can go yet. Used by a session's composer and the new-session page alike.
import { useCallback, useRef, type ClipboardEvent, type ReactNode } from 'react';
import type { AttachmentRefs } from '../../store.ts';
import { AttachButton } from './AttachButton.tsx';
import { DraftTiles } from './DraftTiles.tsx';
import { blockedReason, draftFiles, useDraftFiles } from './draftStore.ts';
import { useDropZone } from './useDropZone.tsx';

export interface ComposerAttachments {
  /** Put on the message box: the drop zone finds its page from it. */
  anchor: React.RefObject<HTMLDivElement | null>;
  hasFiles: boolean;
  tiles: ReactNode;
  button: ReactNode;
  dropZone: ReactNode;
  /** For the text box: a pasted file is attached; pasted text stays text. */
  onPaste: (e: ClipboardEvent) => void;
  /** Why the message cannot go yet (an upload still running, one that failed), or null. */
  blocked: string | null;
  /** The files to send with the message now, or null. */
  refs: () => AttachmentRefs | null;
  /** The message went: the files are the session's now. */
  sent: () => void;
}

export function useAttachments(draftKey: string, disabled = false): ComposerAttachments {
  const files = useDraftFiles(draftKey);
  const anchor = useRef<HTMLDivElement>(null);
  const add = useCallback((list: File[]) => !disabled && draftFiles.add(draftKey, list), [draftKey, disabled]);
  const dropZone = useDropZone(anchor, add);
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const pasted = [...e.clipboardData.files];
      if (pasted.length === 0) return;
      e.preventDefault();
      add(pasted);
    },
    [add],
  );
  return {
    anchor,
    hasFiles: files.length > 0,
    tiles: <DraftTiles draftKey={draftKey} files={files} />,
    button: <AttachButton onFiles={add} disabled={disabled} />,
    dropZone,
    onPaste,
    blocked: blockedReason(files),
    refs: () => draftFiles.refs(draftKey),
    sent: () => draftFiles.sent(draftKey),
  };
}
