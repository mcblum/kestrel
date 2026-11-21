import { describe, expect, it } from 'vitest';
import { flattenTokens, highlightLanguage, HIGHLIGHT_LIMIT, languageOfPath, lineSignature, roleOf, tokenLines, withinHighlightLimit, type HastLike } from './code-highlight.ts';

const text = (value: string): HastLike => ({ type: 'text', value });
const token = (classes: string[], ...children: HastLike[]): HastLike => ({ type: 'element', properties: { className: ['token', ...classes] }, children });
const root = (...children: HastLike[]): HastLike => ({ type: 'root', children });

describe('which grammar a language names', () => {
  it('takes the grammar names and the usual aliases, in any case', () => {
    expect(highlightLanguage('typescript')).toBe('typescript');
    expect(highlightLanguage('ts')).toBe('typescript');
    expect(highlightLanguage('TSX')).toBe('tsx');
    expect(highlightLanguage('sh')).toBe('bash');
    expect(highlightLanguage('shell')).toBe('bash');
    expect(highlightLanguage('zsh')).toBe('bash');
    expect(highlightLanguage('yml')).toBe('yaml');
    expect(highlightLanguage('py')).toBe('python');
    expect(highlightLanguage('rb')).toBe('ruby');
    expect(highlightLanguage('tf')).toBe('hcl');
    expect(highlightLanguage('terraform')).toBe('hcl');
    expect(highlightLanguage('js')).toBe('javascript');
    expect(highlightLanguage('html')).toBe('markup');
    expect(highlightLanguage('c++')).toBe('cpp');
    expect(highlightLanguage('Dockerfile')).toBe('docker');
  });

  it('is null for an unknown language or none, so the block is plain', () => {
    expect(highlightLanguage('brainfuck')).toBeNull();
    expect(highlightLanguage('')).toBeNull();
    expect(highlightLanguage(null)).toBeNull();
    expect(highlightLanguage(undefined)).toBeNull();
  });

  it('reads a file name by its extension or its whole name', () => {
    expect(languageOfPath('ui/src/components/CodeBlock.tsx')).toBe('tsx');
    expect(languageOfPath('server/package.json')).toBe('json');
    expect(languageOfPath('deploy/Dockerfile')).toBe('docker');
    expect(languageOfPath('Dockerfile.dev')).toBe('docker');
    expect(languageOfPath('infra/main.tf')).toBe('hcl');
    expect(languageOfPath('manifests/site.pp')).toBe('puppet');
    expect(languageOfPath('README')).toBeNull();
    expect(languageOfPath('.gitignore')).toBeNull();
    expect(languageOfPath('notes.unknown')).toBeNull();
  });
});

describe('how much is highlighted', () => {
  it('stops at the line limit', () => {
    expect(withinHighlightLimit('a\n'.repeat(HIGHLIGHT_LIMIT.lines - 1))).toBe(true);
    expect(withinHighlightLimit('a\n'.repeat(HIGHLIGHT_LIMIT.lines))).toBe(false);
  });

  it('stops at the character limit', () => {
    expect(withinHighlightLimit('a'.repeat(HIGHLIGHT_LIMIT.chars))).toBe(true);
    expect(withinHighlightLimit('a'.repeat(HIGHLIGHT_LIMIT.chars + 1))).toBe(false);
  });
});

describe('colour roles', () => {
  it('maps Prism types to a few roles, an alias included', () => {
    expect(roleOf(['token', 'keyword'])).toBe('keyword');
    expect(roleOf(['token', 'class-name'])).toBe('type');
    expect(roleOf(['token', 'number'])).toBe('constant');
    expect(roleOf(['token', 'operator'])).toBe('punct');
    expect(roleOf(['token', 'key', 'atrule'])).toBe('keyword');
    expect(roleOf(['token', 'parameter'])).toBeNull();
  });

  it('marks an interpolation as plain, so the code in it is not coloured as the string', () => {
    expect(roleOf(['token', 'interpolation'])).toBe('plain');
  });
});

describe('flattening a highlighted tree', () => {
  it('keeps the code exactly and gives each text the nearest role', () => {
    const tree = root(token(['keyword'], text('const')), text(' x '), token(['operator'], text('=')), text(' '), token(['number'], text('1')));
    const tokens = flattenTokens(tree);
    expect(tokens.map((t) => t.text).join('')).toBe('const x = 1');
    expect(tokens).toEqual([
      { text: 'const', role: 'keyword' },
      { text: ' x ', role: null },
      { text: '=', role: 'punct' },
      { text: ' ', role: null },
      { text: '1', role: 'constant' },
    ]);
  });

  it('colours the code inside an interpolation as code, not as the string', () => {
    const tree = root(token(['template-string'], token(['string'], text('`a ')), token(['interpolation'], token(['punctuation'], text('${')), text('name'), token(['punctuation'], text('}'))), token(['string'], text('`'))));
    expect(flattenTokens(tree)).toEqual([
      { text: '`a ', role: 'string' },
      { text: '${', role: 'punct' },
      { text: 'name', role: null },
      { text: '}', role: 'punct' },
      { text: '`', role: 'string' },
    ]);
  });

  it('joins neighbours with the same role', () => {
    const tree = root(token(['punctuation'], text('(')), token(['punctuation'], text(')')));
    expect(flattenTokens(tree)).toEqual([{ text: '()', role: 'punct' }]);
  });
});

describe('tokens by line', () => {
  it('splits a comment over several lines onto each of them', () => {
    const tokens = flattenTokens(root(token(['comment'], text('/* one\ntwo */')), text('\n'), token(['keyword'], text('let'))));
    expect(tokenLines(tokens)).toEqual([[{ text: '/* one', role: 'comment' }], [{ text: 'two */', role: 'comment' }], [{ text: 'let', role: 'keyword' }]]);
  });

  it('has a list for every line, empty ones included', () => {
    expect(tokenLines([{ text: 'a\n\nb\n', role: null }])).toEqual([[{ text: 'a', role: null }], [], [{ text: 'b', role: null }], []]);
    expect(tokenLines([])).toEqual([[]]);
  });

  it('gives lines coloured the same way the same signature', () => {
    const [a, b] = tokenLines([{ text: 'x = 1\ny = 2', role: null }]);
    expect(lineSignature(a!)).toBe(lineSignature(b!));
    expect(lineSignature([{ text: 'x', role: 'keyword' }])).not.toBe(lineSignature([{ text: 'x', role: null }]));
  });
});
