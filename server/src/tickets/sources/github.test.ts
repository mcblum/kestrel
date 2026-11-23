// GitHub issues as tickets: what `gh api` answers, mapped; never a real GitHub.
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../pull-requests/types.ts';
import { marksDone, type Ticket } from '../../shared/tickets.ts';
import { GITHUB_DONE, GITHUB_NOT_PLANNED, githubCommentArgs, githubMoveArgs, githubAssignedArgs, githubIssueOfKey, githubTicketSource, mapGithubComments, mapGithubIssues } from './github.ts';

const ITEM = {
  number: 12,
  title: 'Retry the webhook on 502',
  repository_url: 'https://api.github.com/repos/acme/hooks',
  html_url: 'https://github.com/acme/hooks/issues/12',
  labels: [{ name: 'In progress' }, { name: 'P1' }],
  assignees: [{ login: 'sam' }],
  created_at: '2026-11-20T10:00:00Z',
  updated_at: '2026-11-22T02:00:00Z',
};

describe('GitHub issues as tickets', () => {
  it('maps an issue and leaves pull requests out', () => {
    const tickets = mapGithubIssues(JSON.stringify({ items: [ITEM, { ...ITEM, number: 13, pull_request: {} }] }));
    expect(tickets).toEqual([
      {
        key: 'github:acme/hooks#12',
        source: 'github',
        tracker: 'GitHub',
        ref: 'hooks#12',
        title: 'Retry the webhook on 502',
        status: { name: 'In progress', category: 'in-progress' },
        project: 'acme/hooks',
        url: 'https://github.com/acme/hooks/issues/12',
        openedAt: Date.parse('2026-11-20T10:00:00Z'),
        updatedAt: Date.parse('2026-11-22T02:00:00Z'),
        priority: 1,
        priorityName: 'P1',
        assignee: 'sam',
        sprint: null,
        repository: { hostName: 'github.com', path: 'acme/hooks' },
      },
    ]);
  });

  it('asks one search for open issues assigned to the user, and reads an issue with its comments', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args.includes('search/issues')) return { stdout: JSON.stringify({ items: [ITEM] }), stderr: '' };
      if (args[1]!.endsWith('/comments?per_page=50')) return { stdout: JSON.stringify([{ user: { login: 'kim' }, created_at: '2026-11-21T00:00:00Z', body: 'Seen on staging.' }, { body: ' ' }]), stderr: '' };
      return { stdout: JSON.stringify({ body: 'It drops the event.\n\n## Acceptance criteria\n- retried three times' }), stderr: '' };
    };
    const source = githubTicketSource(run, '/');
    const list = await source.assignedToMe();
    expect(list.state === 'ready' && list.value.map((t) => t.ref)).toEqual(['hooks#12']);
    expect(calls[0]).toEqual(githubAssignedArgs());
    expect(githubAssignedArgs().join(' ')).toContain('assignee:@me');
    const detail = await source.read(list.state === 'ready' ? list.value[0]! : (null as never));
    expect(detail).toMatchObject({ state: 'ready', value: { criteria: ['retried three times'], comments: [{ author: 'kim', body: 'Seen on staging.' }] } });
  });

  it('says why when gh cannot answer, and finds an issue from its key', async () => {
    const run: CommandRunner = async () => {
      throw Object.assign(new Error('gh'), { code: 'ENOENT' });
    };
    expect((await githubTicketSource(run, '/').assignedToMe()).state).toBe('unavailable');
    expect(githubIssueOfKey('github:acme/hooks#12')).toEqual({ repository: 'acme/hooks', number: 12 });
    expect(githubIssueOfKey('gitlab@x:a/b#1')).toBeNull();
    expect(mapGithubComments('[]')).toEqual([]);
  });
});

describe('Moving a GitHub issue', () => {
  it('offers Done and Close while open, and Open again or the other way of closing once closed', async () => {
    const [open] = mapGithubIssues(JSON.stringify({ items: [ITEM] }));
    const source = githubTicketSource(async () => ({ stdout: '' }), '/');
    expect(await source.statuses(open!)).toEqual({ state: 'ready', value: [GITHUB_DONE, GITHUB_NOT_PLANNED] });
    expect(GITHUB_NOT_PLANNED).toEqual({ name: 'Closed', category: 'done', label: 'Close', notCompleted: true });
    expect([marksDone(GITHUB_DONE), marksDone(GITHUB_NOT_PLANNED)]).toEqual([true, false]); // Done to the Done list, Close to Closed
    expect(await source.statuses({ ...open!, status: GITHUB_DONE })).toEqual({ state: 'ready', value: [{ name: 'Open', category: 'todo' }, GITHUB_NOT_PLANNED] });
    expect(await source.statuses({ ...open!, status: GITHUB_NOT_PLANNED })).toEqual({ state: 'ready', value: [{ name: 'Open', category: 'todo' }, GITHUB_DONE] });
  });

  it('closes an issue as completed (Done) or not planned (Close), reopens it, and says gh’s reason when it cannot', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_c, args) => {
      calls.push([...args]);
      const closed = args.includes('state=closed');
      const reason = args.includes('state_reason=not_planned') ? 'not_planned' : closed ? 'completed' : null;
      return { stdout: JSON.stringify({ ...ITEM, state: closed ? 'closed' : 'open', state_reason: reason }), stderr: '' };
    };
    const [open] = mapGithubIssues(JSON.stringify({ items: [ITEM] }));
    const source = githubTicketSource(run, '/');
    expect(await source.move(open!, 'Done')).toEqual(GITHUB_DONE);
    expect(calls[0]).toEqual(['api', '-X', 'PATCH', 'repos/acme/hooks/issues/12', '-f', 'state=closed', '-f', 'state_reason=completed']);
    expect(await source.move(open!, 'Closed')).toEqual(GITHUB_NOT_PLANNED);
    expect(calls[1]).toEqual(['api', '-X', 'PATCH', 'repos/acme/hooks/issues/12', '-f', 'state=closed', '-f', 'state_reason=not_planned']);
    expect(calls[1]).toEqual(githubMoveArgs('acme/hooks', 12, 'Closed'));
    expect(await source.move({ ...open!, status: GITHUB_DONE }, 'In progress')).toEqual({ name: 'In progress', category: 'in-progress' });
    expect(calls[2]).toEqual(['api', '-X', 'PATCH', 'repos/acme/hooks/issues/12', '-f', 'state=open']);
    const failing: CommandRunner = async () => {
      throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Must have admin rights' });
    };
    await expect(githubTicketSource(failing, '/').move(open!, 'Closed')).rejects.toThrow();
  });

  it('adds a comment, and says gh’s reason when it cannot', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_c, args) => {
      calls.push([...args]);
      return { stdout: '{}', stderr: '' };
    };
    const [open] = mapGithubIssues(JSON.stringify({ items: [ITEM] }));
    await githubTicketSource(run, '/').comment(open!, 'Started on this.');
    expect(calls[0]).toEqual(githubCommentArgs('acme/hooks', 12, 'Started on this.'));
    const failing: CommandRunner = async () => {
      throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Must have admin rights' });
    };
    await expect(githubTicketSource(failing, '/').comment(open!, 'x')).rejects.toThrow();
  });
});

describe('a GitHub milestone', () => {
  it('is the sprint by name, never current', () => {
    const [t] = mapGithubIssues(JSON.stringify({ items: [{ ...ITEM, milestone: { title: 'Future Dev', state: 'open', due_on: '2026-12-01T00:00:00Z' } }] }));
    expect(t!.sprint).toEqual({ name: 'Future Dev', current: false });
  });
});

describe('one GitHub issue’s status, for a ticket that left the list', () => {
  it('asks gh for that issue: closed is done, open is what its labels say, a failure decides nothing', async () => {
    const asked: string[][] = [];
    const answers: Record<string, string> = { '12': JSON.stringify({ ...ITEM, state: 'closed', state_reason: 'not_planned' }), '13': JSON.stringify({ ...ITEM, number: 13, state: 'open' }), '15': JSON.stringify({ ...ITEM, number: 15, state: 'closed', state_reason: 'completed' }) };
    const run: CommandRunner = async (_bin, args) => {
      asked.push([...args]);
      const answer = answers[args[1]!.split('/').at(-1)!];
      if (!answer) throw Object.assign(new Error('HTTP 404'), { stderr: 'gh: Not Found (HTTP 404)' });
      return { stdout: answer };
    };
    const source = githubTicketSource(run, '/');
    const ticket = (n: number) => ({ key: `github:acme/hooks#${n}`, ref: `hooks#${n}` }) as Ticket;
    expect(await source.status(ticket(12))).toEqual({ state: 'ready', value: GITHUB_NOT_PLANNED });
    expect(await source.status(ticket(15))).toEqual({ state: 'ready', value: GITHUB_DONE });
    expect(asked[0]).toEqual(['api', 'repos/acme/hooks/issues/12']);
    expect(await source.status(ticket(13))).toEqual({ state: 'ready', value: { name: 'In progress', category: 'in-progress' } });
    expect((await source.status(ticket(14))).state).toBe('unavailable');
    expect((await source.status({ key: 'jira:x', ref: 'X-1' } as Ticket)).state).toBe('unavailable');
  });
});
