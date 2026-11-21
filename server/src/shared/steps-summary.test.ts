import { describe, expect, it } from 'vitest';
import { stepNote, stepsNote, stepsSummary } from './steps-summary.ts';

const steps = (...texts: string[]) => texts.map((text) => ({ text, status: 'done' as const }));

describe('stepsSummary', () => {
  it('tells one step as what was done', () => {
    expect(stepsSummary(steps('Run cat /some/file'))).toBe('Ran cat /some/file');
    expect(stepsSummary(steps('Edit src/app.ts'))).toBe('Edited src/app.ts');
    expect(stepsSummary(steps('Grep TODO'))).toBe('Searched for TODO');
  });

  it('names the first of one kind and counts the rest', () => {
    expect(stepsSummary(steps('Run cat /some/file', 'Run ls', 'Run pwd', 'Run git status'))).toBe('Ran cat /some/file and 3 other commands');
    expect(stepsSummary(steps('Read a.ts', 'Read b.ts'))).toBe('Read a.ts and 1 other file');
    expect(stepsSummary(steps('Grep foo', 'Glob **/*.ts'))).toBe('Searched for foo and 1 other search');
  });

  it('says each kind when they are mixed: named when single, counted when several, in order of appearance', () => {
    expect(stepsSummary(steps('Read a.ts', 'Read b.ts', 'Read c.ts', 'Read d.ts', 'Run pnpm test', 'Edit app.ts'))).toBe('Read 4 files, ran pnpm test, edited app.ts');
    expect(stepsSummary(steps('Run ls', 'Edit a.ts', 'Run pwd', 'Edit b.ts'))).toBe('Ran 2 commands, edited 2 files');
  });

  it('stops at three kinds and counts what is left', () => {
    expect(stepsSummary(steps('Read a.ts', 'Run ls', 'Edit a.ts', 'Grep x', 'Write b.ts'))).toBe('Read a.ts, ran ls, edited a.ts, and 2 more steps');
  });

  it('leaves text it does not know, and text already in the past tense, as written', () => {
    expect(stepsSummary(steps('Read project instructions', 'Ran the pricing benchmark'))).toBe('Read project instructions, ran the pricing benchmark');
    expect(stepsSummary(steps('Fix the thing'))).toBe('Fix the thing');
    expect(stepsSummary(steps('Fix the thing', 'Review it', 'Ship it'))).toBe('Fix the thing and 2 other steps');
    expect(stepsSummary(steps('Review it', 'Run ls', 'Ship it'))).toBe('2 other steps, ran ls');
  });

  it('counts failures at the end', () => {
    expect(stepsSummary([{ text: 'Run pnpm test', status: 'failed' }, { text: 'Run pnpm lint', status: 'done' }])).toBe('Ran pnpm test and 1 other command · 1 failed');
  });

  it('tells a failed or refused edit as tried, never as edited', () => {
    expect(stepsSummary([{ text: 'Read src/a.ts', status: 'done' }, { text: 'Edit ../other/b.ts', status: 'failed' }])).toBe('Read src/a.ts, tried to edit ../other/b.ts · 1 failed');
    expect(stepsSummary([{ text: 'Edit a.ts', status: 'done' }, { text: 'Edit b.ts', status: 'failed' }])).toBe('Edited a.ts, tried to edit b.ts · 1 failed');
    expect(stepsSummary([{ text: 'Write c.ts', status: 'failed' }])).toBe('Tried to write c.ts · 1 failed');
  });

  it('counts steps stopped before they finished at the end', () => {
    expect(stepsSummary([{ text: 'Run sleep 90', status: 'stopped' }])).toBe('Ran sleep 90 · 1 stopped');
    expect(stepsSummary([{ text: 'Run ls', status: 'failed' }, { text: 'Run sleep 90', status: 'stopped' }])).toBe('Ran ls and 1 other command · 1 failed, 1 stopped');
  });
});

describe('the note under a folded series of steps', () => {
  it('is the first refusal, else the first warning, and its first line; nothing for plain failures', () => {
    expect(stepsNote([{}, { warning: 'Could not refuse it.' }, { refusal: 'In "Epsilon"; use delegate.\nMore.' }])).toEqual({ kind: 'refusal', text: 'In "Epsilon"; use delegate.\nMore.', line: 'In "Epsilon"; use delegate.' });
    expect(stepsNote([{ warning: 'Could not refuse it.' }])).toMatchObject({ kind: 'warning', line: 'Could not refuse it.' });
    expect(stepsNote([{}, {}])).toBeNull();
    // The folded line shortens a long path, so the reason itself is what shows; the full text keeps it.
    const reason = '/private/tmp/claude-501/scratch/repos/beta/README.md is in the Kestrel project "Beta", and a session does not edit another project\'s files.';
    expect(stepNote({ refusal: reason })).toEqual({ kind: 'refusal', text: reason, line: '…/beta/README.md is in the Kestrel project "Beta", and a session does not edit another project\'s files.' });
    expect(stepNote({ refusal: 'See /a/b for more, and ~/Code/x/y/z/file.ts too.' })!.line).toBe('See /a/b for more, and …/z/file.ts too.');
    expect(stepNote({})).toBeNull();
  });
});
