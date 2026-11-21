// Web addresses in plain text the user wrote, so a sent message can show them as links. Only
// http and https addresses written out in full: nothing is guessed from a bare domain, and nothing
// else in the text is treated as markup. Pure; the pieces join back into the text exactly.

export interface LinkPiece {
  kind: 'text' | 'link';
  /** The text as written. For a link it is also the address. */
  text: string;
}

const ADDRESS = /https?:\/\/[^\s<>"`]+/gi;
/** Punctuation that ends a sentence or a clause, not an address. */
const TRAILING = /[.,;:!?'"]+$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (text: string, char: string) => text.split(char).length - 1;

/** An address without the punctuation that only follows it: a full stop, a comma, a bracket that closes one opened before it. */
function trimmed(found: string): string {
  let address = found;
  for (let before = ''; before !== address; ) {
    before = address;
    address = address.replace(TRAILING, '');
    const last = address.at(-1) ?? '';
    const opener = CLOSERS[last];
    if (opener && count(address, last) > count(address, opener)) address = address.slice(0, -1);
  }
  return address;
}

/** `text` as plain text and links, in order. Text with no address is one text piece. */
export function linkPieces(text: string): LinkPiece[] {
  const pieces: LinkPiece[] = [];
  let from = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const address = trimmed(match[0]);
    // "http://" alone, or with only punctuation after it, is not an address.
    if (!/^https?:\/\/[^/?#]/i.test(address)) continue;
    if (match.index > from) pieces.push({ kind: 'text', text: text.slice(from, match.index) });
    pieces.push({ kind: 'link', text: address });
    from = match.index + address.length;
  }
  if (from < text.length || pieces.length === 0) pieces.push({ kind: 'text', text: text.slice(from) });
  return pieces;
}
