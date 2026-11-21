// The paperclip in the message box: opens the file chooser (in the app, the Mac's own; the shell
// says where each chosen file is, see draftStore.ts). Several files at once.
import { useRef } from 'react';
import { Paperclip } from 'lucide-react';

export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="send-icon att-button" aria-label="Attach files" title="Attach files (or drop or paste them here)" disabled={disabled} onClick={() => input.current?.click()}>
        <Paperclip aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = ''; // the same file can be chosen again
          onFiles(files);
        }}
      />
    </>
  );
}
