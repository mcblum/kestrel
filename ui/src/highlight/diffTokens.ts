// Syntax colours in a diff (Changes.tsx), handed to react-diff-view as its `tokens`: for each side,
// the text of every line the diff shows, by line number, highlighted as a whole (so a comment over
// several lines is right) and split back into lines. This is what react-diff-view's own `tokenize`
// does, without the tree reshaping that made it take about 180 ms on a 3,000-line diff against
// about 25 ms for refractor itself. The tokens carry the same role classes as everywhere else
// (@kestrel/server/code-highlight), so one palette serves code blocks, the message box and diffs.
// The diff is drawn plain first and coloured once the tokens are worked out, after the grammars
// have loaded; a diff past the size limit stays plain.
import { useEffect, useState } from 'react';
import { computeNewLineNumber, computeOldLineNumber, isDelete, isInsert, type HunkData, type HunkTokens, type TokenNode } from 'react-diff-view';
import { flattenTokens, HIGHLIGHT_LIMIT, languageOfPath, tokenLines, type CodeToken, type HighlightLanguage } from '@kestrel/server/code-highlight';
import { loadGrammars } from './highlighter.ts';

type Side = 'old' | 'new';

/** One line's tokens as react-diff-view token nodes: role-classed spans and plain text. */
const toNodes = (line: readonly CodeToken[]): TokenNode[] =>
  line.map((token) => (token.role ? { type: 'element', properties: { className: [`tok-${token.role}`] }, children: [{ type: 'text', value: token.text }] } : { type: 'text', value: token.text }));

/** The lines one side of the diff shows, at their line numbers (lines it does not show are empty). */
function sideLines(hunks: readonly HunkData[], side: Side): string[] {
  const byNumber = new Map<number, string>();
  for (const hunk of hunks)
    for (const change of hunk.changes) {
      if (side === 'old' ? isInsert(change) : isDelete(change)) continue;
      byNumber.set(side === 'old' ? computeOldLineNumber(change) : computeNewLineNumber(change), change.content);
    }
  const last = Math.max(0, ...byNumber.keys());
  return Array.from({ length: last }, (_, i) => byNumber.get(i + 1) ?? '');
}

/** Whether a diff is small enough to colour: its changed and context lines, counted together. */
function withinLimit(hunks: readonly HunkData[]): boolean {
  const changes = hunks.flatMap((hunk) => hunk.changes);
  const chars = changes.reduce((sum, change) => sum + change.content.length, 0);
  return changes.length <= HIGHLIGHT_LIMIT.diffLines && chars <= HIGHLIGHT_LIMIT.chars;
}

/** The diff's tokens by role, or null when the highlighter threw (the diff stays plain). */
async function diffTokens(hunks: readonly HunkData[], language: HighlightLanguage): Promise<HunkTokens | null> {
  const { highlightTree } = await loadGrammars();
  const side = (which: Side) => tokenLines(flattenTokens(highlightTree(sideLines(hunks, which).join('\n'), language))).map(toNodes);
  try {
    return { old: side('old'), new: side('new') };
  } catch {
    return null;
  }
}

/** The tokens for one file's diff, by its path's language: null while plain. */
export function useDiffTokens(hunks: HunkData[], path: string): HunkTokens | null {
  const [held, setHeld] = useState<{ hunks: HunkData[]; tokens: HunkTokens } | null>(null);
  const language = languageOfPath(path);
  const eligible = language !== null && withinLimit(hunks);
  useEffect(() => {
    if (!eligible || !language) return;
    let live = true;
    void diffTokens(hunks, language).then(
      (tokens) => live && tokens && setHeld({ hunks, tokens }),
      () => undefined,
    );
    return () => void (live = false);
  }, [hunks, language, eligible]);
  return eligible && held?.hunks === hunks ? held.tokens : null;
}
