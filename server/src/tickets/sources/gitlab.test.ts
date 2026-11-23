// GitLab work items as tickets: what `glab api` answers, mapped; never a real server.
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../pull-requests/types.ts';
import { milestoneSprint, gitlabCommentArgs, gitlabMoveArgs, gitlabAssignedArgs, gitlabTicketSource, issueOfKey, iterationSprint, labelPriority, labelStatus, mapGitlabIssues, mapGitlabNotes } from './gitlab.ts';
import type { Ticket } from '../../shared/tickets.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const HOST = 'gitlab.example.com';

const ISSUE = {
  iid: 27,
  title: 'Upload source maps at release',
  state: 'opened',
  labels: ['workflow::In progress', 'priority::2'],
  references: { full: 'shop/web#27' },
  web_url: `https://${HOST}/shop/web/-/work_items/27`,
  created_at: '2026-11-20T10:00:00Z',
  updated_at: '2026-11-22T02:00:00Z',
  assignees: [{ username: 'sam' }],
  iteration: { id: 4, iid: 2, title: null, state: 2, start_date: '2026-11-16', due_date: '2026-11-29' },
  description: 'Body',
};

describe('GitLab issues as tickets', () => {
  it('maps an issue: key, ref, status and priority from labels, the iteration as the current sprint, the repository', () => {
    const [t] = mapGitlabIssues(JSON.stringify([ISSUE, { title: 'no iid' }]), HOST, NOW);
    expect(t).toEqual({
      key: `gitlab@${HOST}:shop/web#27`,
      source: `gitlab@${HOST}`,
      tracker: 'GitLab',
      ref: 'web#27',
      title: 'Upload source maps at release',
      status: { name: 'In progress', category: 'in-progress' },
      project: 'shop/web',
      url: `https://${HOST}/shop/web/-/work_items/27`,
      openedAt: Date.parse('2026-11-20T10:00:00Z'),
      updatedAt: Date.parse('2026-11-22T02:00:00Z'),
      priority: 2,
      priorityName: 'priority::2',
      assignee: 'sam',
      sprint: { name: 'Iteration 2026-11-16 – 2026-11-29', current: true },
      repository: { hostName: HOST, path: 'shop/web' },
    });
    expect(issueOfKey(t!.key)).toEqual({ host: HOST, path: 'shop/web', iid: 27 });
    expect(() => mapGitlabIssues('{}', HOST, NOW)).toThrow();
  });

  it('reads statuses, priorities and iterations the ways boards name them', () => {
    expect(labelStatus([])).toEqual({ name: 'Open', category: 'todo' });
    expect(labelStatus(['Doing'])).toEqual({ name: 'Doing', category: 'in-progress' });
    expect(labelStatus(['status::In review'])).toEqual({ name: 'In review', category: 'in-review' });
    expect(labelPriority(['P1'])?.priority).toBe(1);
    expect(labelPriority(['priority::high'])?.priority).toBe(2);
    expect(labelPriority(['bug'])).toBeNull();
    expect(iterationSprint(null, NOW)).toBeNull();
    expect(iterationSprint({ title: 'Sprint 9', state: 3, start_date: '2026-10-01', due_date: '2026-10-14' }, NOW)).toEqual({ name: 'Sprint 9', current: false });
  });

  it('leaves GitLab’s own system notes out of the comments', () => {
    expect(mapGitlabNotes(JSON.stringify([{ system: true, body: 'changed the label' }, { body: 'Looks right', author: { username: 'kim' }, created_at: '2026-11-21T00:00:00Z' }]))).toEqual([{ author: 'kim', at: Date.parse('2026-11-21T00:00:00Z'), body: 'Looks right' }]);
  });

  it('asks glab for the issues assigned to the user and for one issue’s comments; a failure says why', async () => {
    const asked: string[][] = [];
    const run: CommandRunner = async (_bin, args) => {
      asked.push([...args]);
      if (args[1]!.startsWith('issues?')) return { stdout: JSON.stringify([ISSUE]) };
      if (args[1]!.endsWith('/notes?sort=asc&order_by=created_at&per_page=50')) return { stdout: '[]' };
      return { stdout: JSON.stringify(ISSUE) };
    };
    const source = gitlabTicketSource(HOST, run, '/', () => NOW);
    const list = await source.assignedToMe();
    expect(asked[0]).toEqual(gitlabAssignedArgs(HOST));
    expect(list.state === 'ready' && list.value).toHaveLength(1);
    const detail = await source.read(list.state === 'ready' ? list.value[0]! : (null as never));
    expect(detail).toEqual({ state: 'ready', value: { description: 'Body', criteria: [], comments: [] } });
    expect(asked[1]).toEqual(['api', 'projects/shop%2Fweb/issues/27', '--hostname', HOST]);
    const failing = gitlabTicketSource(HOST, async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), '/');
    const answer = await failing.assignedToMe();
    expect(answer.state === 'unavailable' && answer.reason).toContain('glab');
  });
});

describe('Moving a GitLab issue', () => {
  it('offers closing an open issue, and reopening a closed one, and says the status GitLab answers with', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_c, args) => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ ...ISSUE, state: args.includes('state_event=close') ? 'closed' : 'opened' }), stderr: '' };
    };
    const source = gitlabTicketSource(HOST, run, '/', () => NOW);
    const [open] = mapGitlabIssues(JSON.stringify([ISSUE]), HOST, NOW);
    expect(await source.statuses(open!)).toEqual({ state: 'ready', value: [{ name: 'Closed', category: 'done' }] });
    expect(await source.move(open!, 'Closed')).toEqual({ name: 'Closed', category: 'done' });
    expect(calls[0]).toEqual(gitlabMoveArgs(HOST, 'shop/web', 27, 'Closed'));
    expect(calls[0]).toContain('state_event=close');
    expect(await source.statuses({ ...open!, status: { name: 'Closed', category: 'done' } })).toEqual({ state: 'ready', value: [{ name: 'Open', category: 'todo' }] });
    expect(await source.move({ ...open!, status: { name: 'Closed', category: 'done' } }, 'In progress')).toEqual({ name: 'In progress', category: 'in-progress' });
    expect(calls[1]).toContain('state_event=reopen');
  });

  it('adds a comment as a note on the issue', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_c, args) => {
      calls.push([...args]);
      return { stdout: '{}', stderr: '' };
    };
    const [open] = mapGitlabIssues(JSON.stringify([ISSUE]), HOST, NOW);
    await gitlabTicketSource(HOST, run, '/', () => NOW).comment(open!, 'Started on this.');
    expect(calls[0]).toEqual(gitlabCommentArgs(HOST, 'shop/web', 27, 'Started on this.'));
    expect(calls[0]).toContain('body=Started on this.');
  });
});

describe('milestones as sprints', () => {
  it('names a milestone where there is no iteration, current only inside its dates while open', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    expect(milestoneSprint({ title: 'Future Dev', state: 'open', due_on: null }, now)).toEqual({ name: 'Future Dev', current: false });
    expect(milestoneSprint({ title: 'M7', state: 'active', start_date: '2026-11-16', due_date: '2026-11-29' }, now)).toEqual({ name: 'M7', current: true });
    expect(milestoneSprint({ title: 'M6', state: 'closed', start_date: '2026-11-16', due_date: '2026-11-29' }, now)).toEqual({ name: 'M6', current: false });
    expect(milestoneSprint(null, now)).toBeNull();
    const [withMilestone] = mapGitlabIssues(JSON.stringify([{ ...ISSUE, iteration: null, milestone: { title: 'M7', state: 'active', start_date: '2026-11-16', due_date: '2026-11-29' } }]), HOST, now);
    expect(withMilestone!.sprint).toEqual({ name: 'M7', current: true });
  });
});

describe('one GitLab issue’s status, for a ticket that left the list', () => {
  it('asks glab for that issue: closed is done, open is what its labels say, a failure decides nothing', async () => {
    const asked: string[][] = [];
    const run: CommandRunner = async (_bin, args) => {
      asked.push([...args]);
      if (args[1]!.endsWith('/issues/7')) return { stdout: JSON.stringify({ ...ISSUE, state: 'closed' }) };
      if (args[1]!.endsWith('/issues/8')) return { stdout: JSON.stringify({ ...ISSUE, state: 'opened', labels: ['workflow::In review'] }) };
      throw Object.assign(new Error('404'), { stderr: '404 Not Found' });
    };
    const source = gitlabTicketSource(HOST, run, '/', () => NOW);
    const ticket = (iid: number) => ({ key: `gitlab@${HOST}:shop/web#${iid}`, ref: `web#${iid}` }) as Ticket;
    expect(await source.status(ticket(7))).toEqual({ state: 'ready', value: { name: 'Closed', category: 'done' } });
    expect(asked[0]).toEqual(['api', 'projects/shop%2Fweb/issues/7', '--hostname', HOST]);
    expect(await source.status(ticket(8))).toEqual({ state: 'ready', value: { name: 'In review', category: 'in-review' } });
    expect((await source.status(ticket(9))).state).toBe('unavailable');
  });
});
