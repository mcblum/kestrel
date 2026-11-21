// The code a review comment points at: the file as it is in the review session's worktree (the
// commit that was reviewed), around the comment's line, in the code colours, with the line marked.
// Read through the session's file route and held once per file (useResource); "Whole file" shows
// all of it, scrolled to the line. The arrow at its top right shows the line in context: the Changes
// pane opens at that file's diff, which in a review is the request's own change, with the line marked.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { excerptAround, extensionOf } from '@kestrel/server/code-excerpt';
import type { FileContent } from '@kestrel/server/files';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { SquareArrowOutUpRight } from 'lucide-react';
import { focusChange } from '../changesFocus.ts';
import { HighlightedCode } from '../highlight/HighlightedCode.tsx';

const asContent = (raw: unknown): Sourced<FileContent> => ready(raw as FileContent);

export function ReviewCommentCode({ sessionId, path, line }: { sessionId: string; path: string; line: number }) {
  const [whole, setWhole] = useState(false);
  const answer = useResource(`/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`, asContent).value;
  const marked = useRef<HTMLSpanElement>(null);
  // The whole file opens at the line, not at its top.
  useEffect(() => {
    if (whole) marked.current?.scrollIntoView({ block: 'center' });
  }, [whole]);
  if (answer.state === 'loading') return <p className="review-code-note">Loading…</p>;
  if (answer.state === 'unavailable') return <p className="review-code-note">{answer.reason || 'Could not read this file.'}</p>;
  const content = answer.value;
  if (content.kind !== 'text') return <p className="review-code-note">{content.kind === 'binary' ? 'This is not a text file.' : 'This file is too large to show.'}</p>;
  const excerpt = excerptAround(content.text, line, whole ? null : undefined);
  const numbers = excerpt.code.split('\n').map((_, i) => excerpt.first + i);
  const shownAll = excerpt.first === 1 && numbers.length === excerpt.total;
  return (
    <div className="review-code">
      <div className="review-code-head">
        <button type="button" className="copy-button" aria-label="Show this line in the Changes pane" title="Show in Changes" onClick={() => focusChange(sessionId, path, line)}>
          <SquareArrowOutUpRight aria-hidden />
        </button>
      </div>
      <div className={`review-code-body${whole ? ' whole' : ''}`} style={{ '--marked': excerpt.marked ?? -1 } as CSSProperties}>
        {excerpt.marked !== null && <span className="review-code-mark" ref={marked} aria-hidden />}
        <span className="review-code-numbers" aria-hidden>
          {numbers.map((n) => (
            <span key={n} className={n === line ? 'on' : undefined}>
              {n}
            </span>
          ))}
        </span>
        <pre>
          <HighlightedCode lang={extensionOf(path)} code={excerpt.code} />
        </pre>
      </div>
      <div className="review-code-foot">
        {excerpt.marked === null && <span>This file has {excerpt.total} lines, so there is no line {line}.</span>}
        {content.truncated && <span>Only the first part of this file was read.</span>}
        {(!shownAll || whole) && (
          <button type="button" className="link-button" onClick={() => setWhole((was) => !was)}>
            {whole ? 'Show less' : `Whole file (${excerpt.total} lines)`}
          </button>
        )}
      </div>
    </div>
  );
}
