// The user's own message in the conversation: what the message box showed while it was typed
// (Matt, 2026-11-19: formatting in the box carries over to the sent message). Plain text with its
// line breaks, `inline code` and fenced blocks like the agent's (@kestrel/server/code-spans; the box
// shows a block without its fence lines and with the same language label, fence-blocks.ts), and
// a line that starts with a bullet or a number laid out as a list item, as the box lays it out
// (@kestrel/server/list-lines). Not markdown: nothing else is formatted, except that web addresses
// are links (@kestrel/server/links).
import { memo, useMemo, type CSSProperties } from 'react';
import { codeBlocks, type CodePiece } from '@kestrel/server/code-spans';
import { fenceStarts } from '@kestrel/server/code-ref';
import { linkPieces } from '@kestrel/server/links';
import { listMarker, markerWidthEm, type ListMarker } from '@kestrel/server/list-lines';
import { CodeFrame, type CodeSource } from './CodeBlock.tsx';

/** Plain text with the web addresses in it as links (never inside code). They open like the agent's links do. */
function Linked({ text }: { text: string }) {
  return linkPieces(text).map((piece, i) =>
    piece.kind === 'link' ? (
      <a key={i} href={piece.text} target="_blank" rel="noreferrer">
        {piece.text}
      </a>
    ) : (
      piece.text
    ),
  );
}

function Line({ pieces }: { pieces: CodePiece[] }) {
  return pieces.map((piece, i) => (piece.kind === 'code' ? <code key={i}>{piece.text.slice(piece.ticks ?? 0, piece.text.length - (piece.ticks ?? 0))}</code> : <Linked key={i} text={piece.text} />));
}

/** The marker of a line that is a list item: it is always at the start of the first, plain piece. */
function markerOf(pieces: readonly CodePiece[]): ListMarker | null {
  const first = pieces[0];
  return first && first.kind === 'text' ? listMarker(first.text) : null;
}

/** A list item: its marker in a column (a bullet drawn as a dot), its wrapped lines under its text. The characters are the ones typed. */
function ListLine({ pieces, marker }: { pieces: CodePiece[]; marker: ListMarker }) {
  const [first, ...rest] = pieces;
  const style = { '--mi-marker': `${markerWidthEm(marker)}em` } as CSSProperties;
  return (
    <span className="mi-list" style={style}>
      <span className={marker.ordered ? 'mi-marker' : 'mi-marker mi-bullet'}>{first!.text.slice(0, marker.length)}</span>
      <Line pieces={[{ ...first!, text: first!.text.slice(marker.length) }, ...rest]} />
    </span>
  );
}

/** `source`: the conversation message this text is, so its code blocks can be opened in a tab. */
export const UserText = memo(function UserText({ text, source }: { text: string; source?: CodeSource }) {
  const parts = useMemo(() => {
    const starts = fenceStarts(text);
    let fences = 0;
    return codeBlocks(text).map((part) => (part.kind === 'fence' ? { ...part, at: starts[fences++] } : part));
  }, [text]);
  return (
    <div className="chat-text user-text">
      {parts.map((part, i) =>
        part.kind === 'fence' ? (
          <div key={i} className="prose user-code">
            <CodeFrame lang={part.lang} code={part.code} source={source && part.at !== undefined ? { ...source, at: part.at } : undefined} />
          </div>
        ) : (
          <p key={i} className="user-prose">
            {part.lines.map((pieces, j) => {
              const marker = markerOf(pieces);
              // A list item is a block of its own, so the line after it needs no line break before it.
              const afterItem = j > 0 && markerOf(part.lines[j - 1]!) !== null;
              return (
                <span key={j}>
                  {j > 0 && !afterItem && '\n'}
                  {marker ? <ListLine pieces={pieces} marker={marker} /> : <Line pieces={pieces} />}
                </span>
              );
            })}
          </p>
        ),
      )}
    </div>
  );
});
