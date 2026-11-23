// A Markdown or PDF file in a tab of the session (Matt, 2026-11-23): Markdown rendered as the
// conversation renders it, a PDF drawn page by page (PdfPages.tsx). The file is read when the tab
// opens and again on Reload; nothing here watches the disk. What the server will not give (another
// kind of file, one outside the session's folders, one too large) is said in its words.
import { lazy, Suspense, useEffect, useState } from 'react';
import { FolderOpen, RotateCw } from 'lucide-react';
import { fileNameOf, viewableKind } from '@kestrel/server/viewable-files';
import { actions, fetchFile } from '../store.ts';
import { showInManager } from '../platform.ts';
import { CopyButton } from './CopyButton.tsx';
import { Markdown } from './Markdown.tsx';
import '../styles/file-document.css';

// pdf.js is large and only a PDF needs it.
const PdfPages = lazy(() => import('./PdfPages.tsx'));

type Loaded = { state: 'loading' } | { state: 'failed'; reason: string } | { state: 'markdown'; text: string } | { state: 'pdf'; data: Uint8Array };

const LOADING: Loaded = { state: 'loading' };

async function read(sessionId: string, path: string): Promise<Loaded> {
  const kind = viewableKind(path);
  if (!kind) return { state: 'failed', reason: 'Kestrel shows Markdown and PDF files. Open this one in another app.' };
  const blob = await fetchFile(`/api/sessions/${encodeURIComponent(sessionId)}/document?path=${encodeURIComponent(path)}`);
  return kind === 'markdown' ? { state: 'markdown', text: await blob.text() } : { state: 'pdf', data: new Uint8Array(await blob.arrayBuffer()) };
}

/** The file as it was when last read; `reload` reads it again and keeps what is shown until the answer is in. */
function useFile(sessionId: string, path: string): { file: Loaded; reload: () => void } {
  const [file, setFile] = useState<Loaded>(LOADING);
  const [asked, setAsked] = useState(0);
  useEffect(() => setFile(LOADING), [sessionId, path]);
  useEffect(() => {
    let current = true;
    read(sessionId, path).then(
      (loaded) => current && setFile(loaded),
      (error: unknown) => current && setFile({ state: 'failed', reason: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
  }, [sessionId, path, asked]);
  return { file, reload: () => setAsked((n) => n + 1) };
}

export function FileDocumentView({ sessionId, path }: { sessionId: string; path: string }) {
  const { file, reload } = useFile(sessionId, path);
  return (
    <div className="file-document">
      <div className="file-document-head">
        <span className="file-document-name">{fileNameOf(path)}</span>
        <span className="file-document-path" title={path}>
          {path}
        </span>
        <span className="file-document-actions">
          <button type="button" className="copy-button" aria-label="Read the file again" title="Read the file again" onClick={reload}>
            <RotateCw aria-hidden />
          </button>
          <button type="button" className="copy-button" aria-label={showInManager()} title={showInManager()} onClick={() => void actions.reveal(path)}>
            <FolderOpen aria-hidden />
          </button>
          <CopyButton value={path} label="path" />
        </span>
      </div>
      {file.state === 'loading' && <p className="file-document-note">Loading…</p>}
      {file.state === 'failed' && <p className="file-document-note">{file.reason}</p>}
      {file.state === 'markdown' && (
        <div className="file-document-scroll">
          <div className="file-document-text prose">{file.text.trim() ? <Markdown text={file.text} sessionId={sessionId} /> : <p className="muted">This file is empty.</p>}</div>
        </div>
      )}
      {file.state === 'pdf' && (
        <Suspense fallback={<p className="file-document-note">Loading…</p>}>
          <PdfPages data={file.data} />
        </Suspense>
      )}
    </div>
  );
}
