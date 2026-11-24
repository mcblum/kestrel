// A rounds review's findings from round to round, and the card that stays when it ends (round-findings.ts).
import { describe, expect, it } from 'vitest';
import type { Finding } from './findings.ts';
import { carryForward, checkEarlier, earlierText, earlierUnknown, fixAllMessage, openFindings, reviewEndLine, roundFindingsText, sanitizeReviewEnd, shownReviewEnd, unstructuredFinding, type ReviewEnd, type RoundFindings } from './round-findings.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'f1', brief: 'It drops the draft.', priority: 'medium', blocking: false, refs: [], ...over });
const round1: RoundFindings = {
  reviewer: 'Critic',
  reviewerId: 'r',
  round: 1,
  rounds: 2,
  verdict: 'findings',
  summary: '',
  findings: [finding({ id: 'f1', priority: 'high', blocking: true, fixAsked: true }), finding({ id: 'f2', brief: 'No test.', priority: 'low' }), finding({ id: 'f3', brief: 'Gone.', dismissed: true })],
};

describe('what became of the round before’s findings', () => {
  it('takes the reviewer’s word on each kept finding, the open ones first', () => {
    const checked = checkEarlier([{ id: 'f2', status: 'fixed', author_says_fixed: true, commit: 'abc1234def' }, { id: 'f1', status: 'open', author_says_fixed: true, commit: 'abc1234', note: 'Still divides by zero.' }], round1.findings);
    expect(checked).toEqual({
      earlier: [
        { id: 'f1', brief: 'It drops the draft.', priority: 'high', status: 'open', claimed: true, commit: 'abc1234', note: 'Still divides by zero.' },
        { id: 'f2', brief: 'No test.', priority: 'low', status: 'fixed', claimed: true, commit: 'abc1234def' },
      ],
    });
  });

  it('refuses, with what to do, a finding left out, one named twice, one that is not there, or a bad commit', () => {
    expect(checkEarlier([{ id: 'f1', status: 'fixed' }], round1.findings)).toEqual({ problem: expect.stringContaining('Say in earlier what became of f2 ("No test.")') });
    expect(checkEarlier([{ id: 'f1', status: 'fixed' }, { id: 'f1', status: 'open' }], round1.findings)).toEqual({ problem: 'earlier names f1 twice.' });
    expect(checkEarlier([{ id: 'f3', status: 'fixed' }], round1.findings)).toEqual({ problem: expect.stringContaining('not a finding of the round before. Its findings are f1, f2') });
    expect(checkEarlier([{ id: 'f1', status: 'fixed', commit: 'HEAD' }, { id: 'f2', status: 'fixed' }], round1.findings)).toEqual({ problem: expect.stringContaining("commit must be a commit's hash") });
    expect(checkEarlier([{ id: 'f1', status: 'gone' }], round1.findings)).toEqual({ problem: 'f1: status must be one of fixed, open, withdrawn.' });
  });

  it('asks for nothing in the first round, and refuses earlier there', () => {
    expect(checkEarlier(undefined, [])).toEqual({ earlier: [] });
    expect(checkEarlier([{ id: 'f1', status: 'open' }], [])).toEqual({ problem: expect.stringContaining('no finding of an earlier round') });
  });

  it('says each one’s fate in words', () => {
    expect(earlierText({ id: 'f2', brief: '', priority: 'low', status: 'fixed', commit: 'abc1234def' })).toBe('Finding 2: fixed in abc1234.');
    expect(earlierText({ id: 'f1', brief: '', priority: 'high', status: 'open', claimed: true, commit: 'abc1234', note: 'Still divides.' })).toBe('Finding 1: still open, though the author says it fixed it in abc1234. Still divides.');
    expect(earlierText({ id: 'f4', brief: '', priority: 'low', status: 'withdrawn' })).toBe('Finding 4: withdrawn by the reviewer.');
  });
});

describe('a finding carried forward', () => {
  it('is the same finding with the same number, marked with its first round; new ones are numbered on from the last', () => {
    const earlier = [{ id: 'f1', brief: '', priority: 'high' as const, status: 'open' as const }, { id: 'f2', brief: '', priority: 'low' as const, status: 'fixed' as const }];
    const findings = carryForward(round1, earlier, [finding({ id: 'f1', brief: 'New, low.', priority: 'low' }), finding({ id: 'f2', brief: 'New, high.', priority: 'high' })]);
    expect(findings.map((f) => [f.id, f.brief, f.since])).toEqual([
      ['f1', 'It drops the draft.', 1],
      ['f4', 'New, high.', undefined],
      ['f5', 'New, low.', undefined],
    ]);
    // A fix asked for in the round before was answered by that round: not carried.
    expect(findings[0]!.fixAsked).toBeUndefined();
    const text = roundFindingsText({ summary: '', findings, earlier });
    expect(text).toContain('Since the round before:\nFinding 1: still open.\nFinding 2: fixed.');
    expect(text).toContain('Finding 1 · High priority · Blocks. It drops the draft.');
  });

  it('keeps the round it was first raised in when it is carried again', () => {
    const round2 = { ...round1, round: 2, findings: [finding({ id: 'f1', since: 1 })] };
    expect(carryForward(round2, [{ id: 'f1', brief: '', priority: 'medium', status: 'open' }], [])[0]!.since).toBe(1);
  });
});

describe('a reviewer that answers in text only', () => {
  it('becomes one finding with its words, marked as unstructured with why, numbered after the round before', () => {
    const f = unstructuredFinding('1. app.ts:3 divides by zero.\n\nVERDICT: FIX FIRST', 'Critic', round1);
    expect(f).toMatchObject({ id: 'f4', priority: 'high', blocking: true, refs: [], detail: '1. app.ts:3 divides by zero.\n\nVERDICT: FIX FIRST' });
    expect(f.brief).toBe('Critic says something must change, but gave its findings only as text. Its words are under the explanation.');
    expect(f.unstructured).toContain('was asked twice to hand its findings over as findings');
    expect(earlierUnknown(round1.findings).map((e) => [e.id, e.status])).toEqual([['f1', 'unknown'], ['f2', 'unknown']]);
  });
});

describe('the card that stays when the review ends with findings', () => {
  const end: ReviewEnd = { reviewer: 'Critic', reviewerId: 'r', rounds: 2, card: 'round-1', state: 'open' };
  const messages = [{ id: 'round-1', roundFindings: round1 }, { id: 'end', reviewEnd: end }];

  it('reads its findings from the last round’s card, kept ones only, highest priority first', () => {
    const { findings, numberOf } = openFindings(messages, end);
    expect(findings.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(numberOf.get('f2')).toBe(2);
  });

  it('sits above the message box while open, and not once the user carried on', () => {
    expect(shownReviewEnd(messages)).toEqual({ id: 'end', end });
    expect(shownReviewEnd([...messages.slice(0, 1), { id: 'end', reviewEnd: { ...end, state: 'closed' } }])).toBeNull();
    expect(shownReviewEnd(undefined)).toBeNull();
  });

  it('says how it ended in a line, and asks for several fixes in one message', () => {
    expect(reviewEndLine(end, 2)).toBe('Critic reviewed this work (2 rounds): 2 findings are still open. They warn and never block.');
    expect(reviewEndLine({ ...end, rounds: 1, problem: 'It could not look again.' }, 1)).toBe('Critic reviewed this work (1 round): 1 finding is still open. They warn and never block. It could not look again.');
    const text = fixAllMessage([{ finding: round1.findings[0]!, number: 1 }, { finding: round1.findings[1]!, number: 2 }], 'Critic');
    expect(text).toMatch(/^Please fix these 2 findings from Critic's review:/);
    expect(text).toContain('Finding 2 · Low priority. No test.');
  });

  it('is read back from storage, an unknown state as open', () => {
    expect(sanitizeReviewEnd({ reviewer: 'Critic', reviewerId: 'r', rounds: 2, state: 'weird', card: 'c' })).toEqual({ reviewer: 'Critic', reviewerId: 'r', rounds: 2, card: 'c', state: 'open' });
    expect(sanitizeReviewEnd({ reviewer: 1 })).toBeNull();
  });
});
