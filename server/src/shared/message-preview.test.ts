import { describe, expect, test } from 'vitest';
import { fromElsewhere, messagePreview, PREVIEW_CHARS, PREVIEW_LINES, previewOf } from './message-preview.ts';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

describe('which messages fold when long', () => {
  test('a child’s brief, work another session sent, a note and Kestrel’s news do; the user’s own words and the agent’s do not', () => {
    expect(fromElsewhere({ byAgent: true })).toBe(true);
    expect(fromElsewhere({ from: { sessionId: 's', title: 'Other' } })).toBe(true);
    expect(fromElsewhere({ notice: 'info' })).toBe(true);
    expect(fromElsewhere({})).toBe(false);
    expect(fromElsewhere({ notice: 'error' })).toBe(false);
    const long = words(400);
    expect(messagePreview({ text: long })).toBeNull();
    expect(messagePreview({ text: long, byAgent: true })).not.toBeNull();
  });
});

describe('where a preview ends', () => {
  test('a short text is shown whole, and so is one only a little past the limit', () => {
    expect(previewOf('A short report.')).toBeNull();
    expect(previewOf('x'.repeat(PREVIEW_CHARS + 10))).toBeNull();
    expect(previewOf(lines(PREVIEW_LINES + 1))).toBeNull();
  });

  test('a long text is cut at a word’s end, within the limit', () => {
    const text = words(400);
    const preview = previewOf(text)!;
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(text.startsWith(preview)).toBe(true);
    expect(text[preview.length]).toBe(' ');
  });

  test('many short lines are cut after the first few lines', () => {
    const preview = previewOf(lines(40))!;
    expect(preview.split('\n')).toHaveLength(PREVIEW_LINES);
    expect(preview.endsWith(`line ${PREVIEW_LINES - 1}`)).toBe(true);
  });

  test('one long word is cut at the limit', () => {
    expect(previewOf('y'.repeat(PREVIEW_CHARS * 3))).toBe('y'.repeat(PREVIEW_CHARS));
  });
});
