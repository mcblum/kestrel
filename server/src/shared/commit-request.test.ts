// Asking the agent to commit: the count and its wording, whether the agent can take it, the Create
// PR menu when changes are uncommitted (and when the agent is busy), and when the request's turn ended.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model.ts';
import { hostTerms } from './host-terms.ts';
import { ready, unavailable, LOADING } from './sourced.ts';
import {
  AGENT_BUSY_REASON,
  changedFilesText,
  COMMIT_AND_CREATE_ID,
  COMMIT_REQUEST,
  commitRequestEnded,
  createPullRequestMenu,
  hasOpenCard,
  isAgentBusy,
  nextCommitStage,
  uncommittedCount,
  uncommittedFilesText,
  uncommittedNotice,
} from './commit-request.ts';

const status = (uncommitted: number) => ready({ uncommitted });
const you = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ author: 'you', time: '', text, ...extra });

describe('uncommittedCount', () => {
  it('is the git status’s own count, whatever has been committed', () => {
    expect(uncommittedCount(status(3))).toBe(3);
    expect(uncommittedCount(status(0))).toBe(0);
  });
  it('claims nothing while the git status is loading or unavailable', () => {
    expect(uncommittedCount(LOADING)).toBe(0);
    expect(uncommittedCount(unavailable('No repository'))).toBe(0);
  });
});

describe('wording', () => {
  it('says the count in the singular and the plural', () => {
    expect(uncommittedFilesText(1)).toBe('1 uncommitted file');
    expect(uncommittedFilesText(3)).toBe('3 uncommitted files');
  });
  it('says the changed files, and how many are uncommitted, as the Changes button and a sidebar row do', () => {
    expect(changedFilesText(1, 0)).toBe('1 changed file');
    expect(changedFilesText(3, 1)).toBe('3 changed files · 1 uncommitted');
    expect(changedFilesText(0, 2)).toBeNull();
  });
  it('says the notice in the host’s words', () => {
    expect(uncommittedNotice(hostTerms('gitlab'))).toBe('You have uncommitted changes. They will not be in this merge request.');
    expect(uncommittedNotice(hostTerms('github'))).toBe('You have uncommitted changes. They will not be in this pull request.');
  });
  it('asks the agent to commit without pushing', () => {
    expect(COMMIT_REQUEST).toMatch(/^Commit the work from this session\./);
    expect(COMMIT_REQUEST).toMatch(/do not push\.$/);
  });
});

describe('isAgentBusy', () => {
  it('is busy while running or waiting for an answer', () => {
    expect(isAgentBusy('running', false)).toBe(true);
    expect(isAgentBusy('attention', true)).toBe(true);
  });
  it('is free when done, interrupted, or failed with nothing to answer', () => {
    expect(isAgentBusy('done', false)).toBe(false);
    expect(isAgentBusy('interrupted', false)).toBe(false);
    expect(isAgentBusy('attention', false)).toBe(false);
  });
  it('finds an unanswered card', () => {
    const card = { id: 'r1', kind: 'approval', title: 'Run', options: [] } as unknown as NonNullable<ChatMessage['input']>;
    expect(hasOpenCard([{ ...you('x'), author: 'agent', input: card }])).toBe(true);
    expect(hasOpenCard([{ ...you('x'), author: 'agent', input: { ...card, resolved: 'Allow' } }])).toBe(false);
    expect(hasOpenCard(undefined)).toBe(false);
  });
});

describe('createPullRequestMenu', () => {
  it('is Manually and Generated alone with nothing uncommitted', () => {
    expect(createPullRequestMenu(0, false)).toEqual([
      { id: 'manual', label: 'Manually' },
      { id: 'generated', label: 'Generated' },
    ]);
  });
  it('puts Commit and create first, with the count', () => {
    const menu = createPullRequestMenu(3, false);
    expect(menu.map((m) => m.id)).toEqual([COMMIT_AND_CREATE_ID, 'manual', 'generated']);
    expect(menu[0]).toEqual({ id: COMMIT_AND_CREATE_ID, label: 'Commit and create', hint: '3 uncommitted files' });
    expect(menu[1]!.separatorBefore).toBe(true);
  });
  it('disables Commit and create with the reason while the agent works', () => {
    const [commit, manual, generated] = createPullRequestMenu(1, true);
    expect(commit).toMatchObject({ disabled: true, hint: AGENT_BUSY_REASON });
    expect(manual!.disabled).toBeUndefined();
    expect(generated!.disabled).toBeUndefined();
  });
});

describe('nextCommitStage', () => {
  it('waits for the session to be seen working before an end counts', () => {
    expect(nextCommitStage('sent', 'done', false)).toBe('sent');
    expect(nextCommitStage('sent', 'running', false)).toBe('working');
    expect(nextCommitStage('working', 'done', false)).toBe('ended');
    expect(nextCommitStage('working', 'interrupted', false)).toBe('ended');
  });
  it('does not end on a question in the middle of the turn', () => {
    expect(nextCommitStage('working', 'attention', false)).toBe('working');
    expect(nextCommitStage('sent', 'attention', false)).toBe('sent');
  });
  it('ends when the request’s own message says its turn ended, whatever was seen', () => {
    expect(nextCommitStage('sent', 'done', true)).toBe('ended');
    expect(nextCommitStage('working', 'attention', true)).toBe('ended');
  });
});

describe('commitRequestEnded', () => {
  it('finds the request sent since, with its turn ended', () => {
    expect(commitRequestEnded([you(COMMIT_REQUEST, { sentAt: 100, turnEndedAt: 200 })], 100)).toBe(true);
  });
  it('ignores an older request, one still running, and other messages', () => {
    expect(commitRequestEnded([you(COMMIT_REQUEST, { sentAt: 50, turnEndedAt: 60 })], 100)).toBe(false);
    expect(commitRequestEnded([you(COMMIT_REQUEST, { sentAt: 100 })], 100)).toBe(false);
    expect(commitRequestEnded([you('Something else', { sentAt: 100, turnEndedAt: 200 })], 100)).toBe(false);
    expect(commitRequestEnded(undefined, 100)).toBe(false);
  });
});
