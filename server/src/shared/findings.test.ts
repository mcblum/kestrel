// The one finding shape both reviews use (findings.ts), the rounds review's card (round-findings.ts)
// and the sidebar's pure rules (asides.ts).
import { describe, expect, it } from 'vitest';
import { asideBrief, asideConclusion, asidePlaceholder, asideRefusal, asideTitle, checkSubject, pointSummary, sameAside, sanitizeAside } from './asides.ts';
import { checkFindings, countLine, findingAsideKey, findingSubject, START_FINDING_ASIDE, findingSummary, findingText, freshFindings, numberedFindings, openQuestion, QUESTION_MAX, type Finding } from './findings.ts';
import { editedFindings } from './review-reply.ts';
import { answerMessage, fixMessage, roundFindingsText, roundNotice, roundVerdict } from './round-findings.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'f1', brief: 'It drops the draft.', priority: 'medium', blocking: false, refs: [], ...over });

describe('findings', () => {
  it('takes a question on a finding, and refuses one that is too long', () => {
    expect(checkFindings([{ brief: 'x', priority: 'low', blocking: false, question: ' Is this intended? ' }])).toEqual({ findings: [{ id: 'f1', brief: 'x', priority: 'low', blocking: false, refs: [], question: 'Is this intended?' }] });
    expect(checkFindings([{ brief: 'x', priority: 'low', blocking: false, question: 'q'.repeat(QUESTION_MAX + 1) }])).toEqual({ problem: expect.stringContaining('question is longer') });
  });

  it('does not let an agent hand over an answer, a fix asked for or a dismissal', () => {
    const given = [{ brief: 'x', priority: 'low', blocking: false, question: 'Why?', answer: 'Because.', fixAsked: true, dismissed: true }];
    expect(freshFindings(given)).toEqual({ findings: [{ id: 'f1', brief: 'x', priority: 'low', blocking: false, refs: [], question: 'Why?' }] });
  });

  it('keeps the question and the answer when the user edits a pull-request review card', () => {
    const own = [finding({ question: 'Why?', answer: 'Because.' })];
    const edited = editedFindings(own, [{ ...own[0], brief: 'Reworded.', question: 'Forged?', answer: 'Forged.' }]);
    expect(edited).toEqual({ findings: [{ ...own[0], brief: 'Reworded.' }] });
  });

  it('numbers kept findings in the order shown, blocking first, the dismissed ones last and unnumbered', () => {
    const { shown, numberOf } = numberedFindings([finding({ id: 'f1' }), finding({ id: 'f2', blocking: true }), finding({ id: 'f3', dismissed: true })]);
    expect(shown.map((f) => f.id)).toEqual(['f2', 'f1', 'f3']);
    expect([...numberOf]).toEqual([['f2', 1], ['f1', 2]]);
  });

  it('says a finding in a line, cut at a word, and says how many a card holds', () => {
    expect(findingSummary({ brief: 'Short.' })).toBe('Short.');
    const long = findingSummary({ brief: `${'word '.repeat(60)}end` });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
    expect(countLine([finding({ blocking: true }), finding(), finding({ dismissed: true })])).toBe('2 findings: 2 medium · 1 blocks · 1 dismissed');
  });

  it('has an open question only while unanswered and kept', () => {
    expect(openQuestion(finding({ question: 'Why?' }))).toBe(true);
    expect(openQuestion(finding({ question: 'Why?', answer: 'So.' }))).toBe(false);
    expect(openQuestion(finding({ question: 'Why?', dismissed: true }))).toBe(false);
    expect(openQuestion(finding())).toBe(false);
  });

  it('writes a finding out with its question and answer', () => {
    expect(findingText(finding({ question: 'Why?', answer: 'So.', refs: [{ path: 'a.ts', line: 3 }] }), 2)).toBe('Finding 2 · Medium priority. It drops the draft.\nAt: a.ts:3\nQuestion for the user: Why?\nThe user\'s answer: So.');
  });
});

describe('a rounds review card', () => {
  it('must change something when it asks for changes or a kept finding blocks', () => {
    expect(roundVerdict('request_changes', [])).toBe('findings');
    expect(roundVerdict('approve', [finding({ blocking: true })])).toBe('findings');
    expect(roundVerdict('approve', [finding({ blocking: true, dismissed: true })])).toBe('clean');
    expect(roundVerdict('comment', [finding()])).toBe('clean');
  });

  it('gives the author the kept findings, each by its own number, so a finding keeps it from round to round', () => {
    const text = roundFindingsText({ summary: 'Mostly fine.', findings: [finding({ id: 'f1' }), finding({ id: 'f2', brief: 'Blocks.', blocking: true }), finding({ id: 'f3', brief: 'Gone.', dismissed: true })] });
    expect(text.startsWith('Mostly fine.\n\nFinding 2 · Medium priority · Blocks. Blocks.')).toBe(true);
    expect(text).toContain('Finding 1 · Medium priority. It drops the draft.');
    expect(text).not.toContain('Gone.');
  });

  it('says what comes next, and what the user sends from a finding', () => {
    expect(roundNotice({ reviewer: 'Astra', round: 1, rounds: 2 })).toContain('Astra looks again (round 2 of 2)');
    expect(roundNotice({ reviewer: 'Astra', round: 2, rounds: 2 })).toContain('the user decides from here');
    expect(fixMessage(finding(), 1, 'Astra')).toContain("Please fix this finding from Astra's review");
    expect(answerMessage(finding({ question: 'Why?' }), 1, 'Because.')).toContain('My answer: Because.');
  });
});

describe('a sidebar', () => {
  const finding2 = finding({ id: 'f2', fix: 'Keep it.' });

  it('about a finding: named as the card numbers it, with the finding in full for the agent', () => {
    const subject = findingSubject(finding2, 2);
    expect(subject).toEqual({ name: 'Finding #2', summary: 'It drops the draft.', context: 'The finding:\n\nFinding 2 · Medium priority. It drops the draft.\nSuggested fix: Keep it.' });
    expect(findingSubject(finding2, undefined).name).toBe('this finding');
    expect(findingAsideKey('card', 'f2')).toBe('finding:card:f2');
    expect(START_FINDING_ASIDE).toBe('Start sidebar about this finding');
  });

  it('speaks of its subject, in Matt\'s words, or of the point when it has none', () => {
    expect(asidePlaceholder({ name: 'Finding #2' })).toBe('Ask any questions you have about Finding #2');
    expect(asidePlaceholder({})).toBe('Ask any questions you have about this point in the conversation');
    expect(asideTitle({ name: 'Finding #2', summary: 'x' })).toBe('Sidebar: Finding #2');
    expect(asideTitle({ summary: 'Build it' })).toBe('Sidebar: Build it');
    expect(pointSummary('  ')).toBe('A card in the conversation.');
  });

  it('is the same sidebar for the same key in the same session', () => {
    expect(sameAside({ sessionId: 's1', key: 'k' }, { sessionId: 's1', key: 'k' })).toBe(true);
    expect(sameAside({ sessionId: 's1', key: 'k' }, { sessionId: 's2', key: 'k' })).toBe(false);
  });

  it('is kept as stored, and nothing else is one', () => {
    const of = { sessionId: 's1', at: 'm1', key: 'point:m1', name: 'Finding #1', summary: 'x', whole: true as const };
    expect(sanitizeAside(JSON.parse(JSON.stringify(of)))).toEqual(of);
    expect(sanitizeAside({ sessionId: 's1', cardId: 'c', findingId: 'f1' })).toBeNull();
  });

  it('takes a subject only with a name, and within its limits', () => {
    expect(checkSubject(undefined)).toEqual({ subject: null });
    expect(checkSubject({ name: ' Finding #1 ', summary: ' s ' })).toEqual({ subject: { name: 'Finding #1', summary: 's' } });
    expect(checkSubject({ summary: 's' })).toHaveProperty('problem');
    expect(checkSubject({ name: 'n', summary: 's', context: 'c'.repeat(9_000) })).toHaveProperty('problem');
  });

  it('starts only where the agent can fork, and says why not', () => {
    expect(asideRefusal('claude')).toBeNull();
    expect(asideRefusal('codex')).toBeNull();
    expect(asideRefusal('opencode')).toContain('OpenCode cannot fork a conversation');
  });

  it('tells the agent it only talks, what it is about, and when its copy runs past the point', () => {
    const of = { sessionId: 's1', at: 'm1', key: 'k', name: 'Finding #2', summary: 'x' };
    expect(asideBrief(of, 'ABOUT')).toContain('about Finding #2');
    expect(asideBrief(of, 'ABOUT')).toContain('cannot change any file');
    expect(asideBrief(of, 'ABOUT').endsWith('ABOUT')).toBe(true);
    expect(asideBrief(of, 'ABOUT')).not.toContain('runs past');
    expect(asideBrief({ ...of, whole: true }, 'ABOUT')).toContain('runs past that point');
  });

  it('brings its last answer back named, for the message box', () => {
    expect(asideConclusion({ name: 'Finding #2' }, '  Fix it first. ')).toBe('From the sidebar about Finding #2:\n\nFix it first.');
    expect(asideConclusion({}, 'Yes.')).toBe('From the sidebar about this point in the conversation:\n\nYes.');
  });
});

describe('priority', () => {
  it('orders a card highest priority first, the ones that block first within a priority', () => {
    const order = numberedFindings([finding({ id: 'f1', priority: 'low', blocking: true }), finding({ id: 'f2', priority: 'medium' }), finding({ id: 'f3', priority: 'high' }), finding({ id: 'f4', priority: 'medium', blocking: true })]).shown.map((f) => f.id);
    expect(order).toEqual(['f3', 'f4', 'f2', 'f1']);
  });

  it('counts a card by priority, highest first, and marks posted text with the priority first', () => {
    expect(countLine([finding({ priority: 'low' }), finding({ priority: 'high', blocking: true }), finding({ priority: 'high' })])).toBe('3 findings: 2 high, 1 low · 1 blocks');
    expect(countLine([])).toBe('0 findings');
    expect(findingText(finding({ priority: 'high', blocking: true }))).toBe('High priority · Blocks. It drops the draft.');
  });
});
