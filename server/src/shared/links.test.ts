import { describe, expect, it } from 'vitest';
import { linkPieces } from './links.ts';

const links = (text: string) => linkPieces(text).filter((p) => p.kind === 'link').map((p) => p.text);
const joined = (text: string) => linkPieces(text).map((p) => p.text).join('');

describe('linkPieces', () => {
  it('finds http and https addresses and leaves the rest as text', () => {
    expect(linkPieces('see https://example.com/a?b=1#c and http://x.test now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a?b=1#c' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'http://x.test' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('leaves the punctuation that follows an address outside it', () => {
    expect(links('Is it https://example.com/page? Yes: https://example.com/x, and https://example.com/y.')).toEqual(['https://example.com/page', 'https://example.com/x', 'https://example.com/y']);
    expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(links('"https://example.com/q"!')).toEqual(['https://example.com/q']);
  });

  it('keeps brackets that belong to the address', () => {
    expect(links('https://en.wikipedia.org/wiki/Kestrel_(bird) is good')).toEqual(['https://en.wikipedia.org/wiki/Kestrel_(bird)']);
    expect(links('(https://en.wikipedia.org/wiki/Kestrel_(bird))')).toEqual(['https://en.wikipedia.org/wiki/Kestrel_(bird)']);
  });

  it('guesses nothing: a bare domain, another scheme and a lone scheme are text', () => {
    for (const text of ['example.com', 'www.example.com/page', 'ftp://example.com', 'mailto:a@b.c', 'http://', 'https://.', 'javascript:alert(1)']) expect(links(text)).toEqual([]);
  });

  it('always joins back into the text as written', () => {
    for (const text of ['', 'plain', 'a https://x.test/y). b', 'https://x.test', 'two https://a.test https://b.test.', 'http:// and https://ok.test/']) expect(joined(text)).toBe(text);
  });

  it('answers with one text piece when there is no address', () => {
    expect(linkPieces('nothing here')).toEqual([{ kind: 'text', text: 'nothing here' }]);
    expect(linkPieces('')).toEqual([{ kind: 'text', text: '' }]);
  });
});
