import { describe, expect, it } from 'vitest';
import { cleanTitle, titleIsEnough } from './title.ts';

describe('cleanTitle', () => {
  it('keeps a plain title as it is', () => {
    expect(cleanTitle('Fix login redirect loop')).toBe('Fix login redirect loop');
  });

  it('takes the first non-empty line', () => {
    expect(cleanTitle('\n\n  Add dark mode toggle  \nBecause the user asked')).toBe('Add dark mode toggle');
  });

  it('strips quotes, backticks, markdown and a Title: label', () => {
    expect(cleanTitle('"Migrate database to SQLite"')).toBe('Migrate database to SQLite');
    expect(cleanTitle('**Title:** `Refactor auth module`')).toBe('Refactor auth module');
    expect(cleanTitle('# Speed up test suite')).toBe('Speed up test suite');
    expect(cleanTitle('Title: “Rename session tabs”')).toBe('Rename session tabs');
  });

  it('drops trailing punctuation and collapses whitespace', () => {
    expect(cleanTitle('Debug   flaky   upload tests.')).toBe('Debug flaky upload tests');
    expect(cleanTitle('Why does the build fail?!')).toBe('Why does the build fail');
  });

  it('caps at 60 characters on a word boundary', () => {
    const out = cleanTitle('Investigate intermittent websocket disconnects during extremely long uploads')!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toBe('Investigate intermittent websocket disconnects during');
  });

  it('is null for empty replies, refusals and long sentences', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('  \n "" \n')).toBeNull();
    expect(cleanTitle("I'm sorry, but I can't help with that.")).toBeNull();
    expect(cleanTitle('This conversation is about the user wanting to change how the session titles are generated in the app')).toBeNull();
  });
});

describe('titleIsEnough', () => {
  it('skips a short one-line prompt', () => {
    expect(titleIsEnough('Fix the build', 'Fix the build')).toBe(true);
  });

  it('does not skip a long title or a prompt of several lines', () => {
    expect(titleIsEnough('Please look at why the upload page hangs after', 'Please look at why the upload page hangs after a while')).toBe(false);
    expect(titleIsEnough('Fix the build', 'Fix the build\nIt fails on CI with a linker error')).toBe(false);
  });
});
