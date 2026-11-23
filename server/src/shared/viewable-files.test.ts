import { expect, test } from 'vitest';
import { fileNameOf, tooLargeToView, viewableKind, viewablePathIn, VIEWABLE_MAX_BYTES } from './viewable-files.ts';

test('Markdown and PDF are shown, by extension in any case; nothing else is', () => {
  expect(viewableKind('README.md')).toBe('markdown');
  expect(viewableKind('notes.MARKDOWN')).toBe('markdown');
  expect(viewableKind('report.final.PDF')).toBe('pdf');
  expect(viewableKind('report.csv')).toBeNull();
  expect(viewableKind('md')).toBeNull();
  expect(viewableKind('pdf')).toBeNull();
});

test('a file name is the last part of its path', () => {
  expect(fileNameOf('/tmp/out/report.pdf')).toBe('report.pdf');
  expect(fileNameOf('C:\\out\\notes.md')).toBe('notes.md');
  expect(fileNameOf('plan.md')).toBe('plan.md');
});

test('a file over its limit is refused with the limit in words', () => {
  expect(tooLargeToView('markdown', VIEWABLE_MAX_BYTES.markdown)).toBeNull();
  expect(tooLargeToView('markdown', VIEWABLE_MAX_BYTES.markdown + 1)).toMatch(/larger than 2 MB/);
  expect(tooLargeToView('pdf', VIEWABLE_MAX_BYTES.pdf + 1)).toMatch(/PDF is larger than 100 MB/);
});

test('a path named in a message opens when it is a file Kestrel shows', () => {
  expect(viewablePathIn('docs/plan.md')).toBe('docs/plan.md');
  expect(viewablePathIn(' /work/out/report.pdf ')).toBe('/work/out/report.pdf');
  expect(viewablePathIn('docs/plan.md:42')).toBe('docs/plan.md');
  expect(viewablePathIn('file:///work/my%20notes.md')).toBe('/work/my notes.md');
  expect(viewablePathIn('my notes.md')).toBe('my notes.md');
});

test('a web address, another kind of file and a bare extension do not', () => {
  expect(viewablePathIn('https://example.com/guide.md')).toBeNull();
  expect(viewablePathIn('src/index.ts')).toBeNull();
  expect(viewablePathIn('.md')).toBeNull();
  expect(viewablePathIn('#plan.md')).toBeNull();
  expect(viewablePathIn('one.md\ntwo.md')).toBeNull();
  expect(viewablePathIn('')).toBeNull();
});
