// Which lines of a pull request's diff take a review comment, and where each finding goes (diff-anchors.ts).
import { describe, expect, it } from 'vitest';
import { anchorOf, anchorsFromDiff, placeFinding, placementText } from './diff-anchors.ts';
import type { Finding } from './findings.ts';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,6 +10,8 @@ export function total() {',
  '   const a = 1;',
  '   const b = 2;',
  '-  return a + b;',
  '+  const c = 3;',
  '+  const d = 4;',
  '+  return a + b + c + d;',
  '   }',
  ' ',
  ' export const x = 1;',
  '@@ -40,3 +42,4 @@ export function other() {',
  '   one();',
  '+  two();',
  '   three();',
  ' }',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 90%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -1,2 +1,2 @@',
  '-const n = 1;',
  '+const n = 2;',
  ' export { n };',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
].join('\n');

const anchors = anchorsFromDiff(DIFF);
const finding = (refs: Finding['refs']): Pick<Finding, 'refs'> => ({ refs });

describe('reading a diff', () => {
  it('knows each changed file by its new path, and the old one when it was renamed; a deleted file has none', () => {
    expect(Object.keys(anchors.files).sort()).toEqual(['new/name.ts', 'src/app.ts']);
    expect(anchors.files['new/name.ts']!.old).toBe('old/name.ts');
    expect(anchors.files['src/app.ts']!.old).toBeUndefined();
  });

  it('takes added lines and the context around them, with the old line where there was one', () => {
    expect(anchorOf(anchors, 'src/app.ts', 10)).toEqual({ line: 10, hunk: 0, oldLine: 10 });
    expect(anchorOf(anchors, 'src/app.ts', 12)).toEqual({ line: 12, hunk: 0 });
    expect(anchorOf(anchors, 'src/app.ts', 15)).toEqual({ line: 15, hunk: 0, oldLine: 13 });
    expect(anchorOf(anchors, 'src/app.ts', 17)).toEqual({ line: 17, hunk: 0, oldLine: 15 });
    expect(anchorOf(anchors, 'src/app.ts', 18)).toBeNull();
    expect(anchorOf(anchors, 'src/app.ts', 43)).toEqual({ line: 43, hunk: 1 });
  });
});

describe('where a finding goes', () => {
  it('on its line when the line is part of the diff', () => {
    expect(placeFinding(finding([{ path: 'src/app.ts', line: 12 }]), anchors)).toEqual({ where: 'code', ref: { path: 'src/app.ts', line: 12 }, line: 12 });
  });

  it('on a range when all of it is in one hunk, and on its first line when not', () => {
    expect(placeFinding(finding([{ path: 'src/app.ts', line: 12, end: 14 }]), anchors)).toEqual({ where: 'code', ref: { path: 'src/app.ts', line: 12, end: 14 }, start: 12, line: 14 });
    expect(placeFinding(finding([{ path: 'src/app.ts', line: 14, end: 43 }]), anchors)).toMatchObject({ where: 'code', line: 14 });
    expect(placeFinding(finding([{ path: 'src/app.ts', line: 14, end: 43 }]), anchors)).not.toHaveProperty('start');
  });

  it('on the first of its references that can take it', () => {
    expect(placeFinding(finding([{ path: 'README.md', line: 1 }, { path: 'new/name.ts', line: 1 }]), anchors)).toEqual({ where: 'code', ref: { path: 'new/name.ts', line: 1 }, line: 1, oldPath: 'old/name.ts' });
  });

  it('in the summary, with why, when no line can take it', () => {
    expect(placeFinding(finding([]), anchors)).toEqual({ where: 'summary', reason: 'it names no line of code' });
    expect(placeFinding(finding([{ path: 'README.md', line: 1 }]), anchors)).toEqual({ where: 'summary', reason: 'README.md is not part of this pull request' });
    expect(placeFinding(finding([{ path: 'src/app.ts', line: 30 }]), anchors)).toEqual({ where: 'summary', reason: "src/app.ts:30 is not part of this pull request's changes" });
  });

  it('on its first line, for the host to decide, when the diff could not be read', () => {
    expect(placeFinding(finding([{ path: 'a.ts', line: 3 }]), undefined)).toEqual({ where: 'code', ref: { path: 'a.ts', line: 3 }, line: 3, unchecked: true });
  });

  it('says so on the card in words', () => {
    expect(placementText(placeFinding(finding([{ path: 'src/app.ts', line: 12, end: 14 }]), anchors))).toBe('On the code at src/app.ts:12–14.');
    expect(placementText(placeFinding(finding([{ path: 'README.md', line: 1 }]), anchors))).toBe('In the summary, because README.md is not part of this pull request.');
  });
});
