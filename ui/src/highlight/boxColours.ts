// Syntax colours for the code blocks in the message box (MessageInput.tsx). The box is drawn plain
// (messageInputDom.ts `paint`); this runs after, and wraps the characters already in each code line
// in spans by token role. It changes no character: the text read back, every offset, the caret and
// the selection stay as they were (the selection is put back by offset when a line under it is
// rewritten). A block is tokenized as a whole, so a comment or template string over several lines
// is coloured right, and its tokens are laid onto its line elements one line each. A line whose
// colours did not change is not touched, and a block whose code did not change is a cache hit, so
// typing in one block re-tokenizes only that block.
import { fenceBlocks, type FenceBlock } from '@kestrel/server/fence-blocks';
import { blockLanguage } from '@kestrel/server/code-guess';
import { lineSignature, tokenLines, type CodeToken, type HighlightLanguage } from '@kestrel/server/code-highlight';
import { selectRange, selectionIn } from '../components/messageInputDom.ts';
import { loadedGrammars, loadGrammars, tokensNow } from './highlighter.ts';

/** How each line element is coloured now ('' for plain), so an unchanged line is left alone. */
const coloured = new WeakMap<HTMLElement, string>();

interface CodeBlockAt {
  block: FenceBlock;
  language: HighlightLanguage;
}

/** The blocks of `text` with code in them and a language Kestrel highlights: the one named, or the one the code reads as. */
const highlightable = (text: string): CodeBlockAt[] =>
  fenceBlocks(text).flatMap((block) => {
    const language = block.bodyLines > 0 ? blockLanguage(block.lang, text.slice(block.bodyStart, block.bodyEnd)) : null;
    return language ? [{ block, language }] : [];
  });

/** Whether the box needs the grammars at all: only when it holds a block in a language it highlights. */
export const boxNeedsGrammars = (text: string): boolean => highlightable(text).length > 0;

/** The signature of a line's colours; '' when nothing in it has a colour. */
const signatureOf = (tokens: readonly CodeToken[] | null): string => (tokens?.some((t) => t.role) ? lineSignature(tokens) : '');

/** Replace a code line's characters with the same characters in token spans; its line break and placeholder stay. */
function recolour(el: HTMLElement, tokens: readonly CodeToken[] | null, lineText: string): void {
  const brk = el.textContent!.endsWith('\n') ? '\n' : '';
  const tail = [...el.childNodes].filter((n) => n.nodeName === 'BR');
  const pieces = (tokens ?? [{ text: lineText, role: null }]).map((token) => {
    if (!token.role) return document.createTextNode(token.text);
    const span = document.createElement('span');
    span.className = `tok-${token.role}`;
    span.textContent = token.text;
    return span;
  });
  el.replaceChildren(...pieces, ...(brk ? [document.createTextNode(brk)] : []), ...tail);
}

/** The line elements of one block that need new colours, with the tokens they need. */
function changedLines(text: string, at: CodeBlockAt, lines: readonly { el: HTMLElement }[]): { el: HTMLElement; tokens: CodeToken[] | null; text: string }[] {
  const code = text.slice(at.block.bodyStart, at.block.bodyEnd);
  const tokens = tokensNow(at.language, code);
  const byLine = tokens ? tokenLines(tokens) : null;
  const first = text.slice(0, at.block.bodyStart).split('\n').length - 1;
  return code.split('\n').flatMap((lineText, j) => {
    const el = lines[first + j]?.el;
    if (!el || !el.classList.contains('mi-fence') || el.classList.contains('mi-fence-hidden')) return [];
    // Never colour a line whose characters are not the ones tokenized.
    if (el.textContent!.replace(/\n$/, '') !== lineText) return [];
    const lineTokens = byLine?.[j] ?? null;
    const signature = signatureOf(lineTokens);
    return (coloured.get(el) ?? '') === signature ? [] : [{ el, tokens: signature ? lineTokens : null, text: lineText }];
  });
}

/**
 * Colour the code lines of `text` as drawn in `root` (`lines` is what `paint` returned for it).
 * Needs the grammars loaded; without them it does nothing.
 */
export function colourBox(root: HTMLElement, text: string, lines: readonly { el: HTMLElement }[]): void {
  if (!loadedGrammars()) return;
  const changes = highlightable(text).flatMap((at) => changedLines(text, at, lines));
  if (changes.length === 0) return;
  const focused = root.ownerDocument.activeElement === root;
  const sel = focused ? selectionIn(root) : null;
  for (const change of changes) {
    recolour(change.el, change.tokens, change.text);
    coloured.set(change.el, signatureOf(change.tokens));
  }
  if (sel) selectRange(root, sel.start, sel.end, sel.backward);
}

/** Load the grammars when `text` needs them; resolves once they are here (at once when they are). */
export const grammarsFor = (text: string): Promise<unknown> | null => (loadedGrammars() || !boxNeedsGrammars(text) ? null : loadGrammars());
