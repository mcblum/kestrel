// Jira Cloud as a ticket source, and connecting it: what Jira's REST API answers, scripted. No test
// reaches Jira, and the token is never in what Settings is told.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../refused.ts';
import { memoryCredentials, sealedCredentials } from '../credentials.ts';
import { JiraConnection } from '../jira-connection.ts';
import { jiraCategory, jiraSprint, jiraTicketSource, mapJiraDetail, siteHost, sprintFieldId } from './jira.ts';
import type { Ticket } from '../../shared/tickets.ts';

const SITE = 'team.atlassian.net';
const CREDS = { site: SITE, email: 'me@example.com', token: 'secret-token' };

type Call = { url: string; method: string; body?: string; auth: string };

// What version 3 gives for text: a document, not a string.
const para = (...content: unknown[]) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)) }] });
const DESCRIPTION = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Why' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hits the cache' }] }] }] },
  ],
};

function scripted(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method ?? 'GET', ...(init.body ? { body: init.body } : {}), auth: init.headers.Authorization! });
    const path = url.replace(`https://${SITE}`, '').replace(/\?.*$/, '');
    const answer = answers[`${init.method ?? 'GET'} ${path}`] ?? answers[path] ?? { status: 404, body: {} };
    const status = answer.status ?? 200;
    return { status, ok: status < 300, json: async () => answer.body, text: async () => JSON.stringify(answer.body) };
  };
  return { calls, fetcher };
}

const ISSUE = {
  key: 'PLAT-12',
  fields: {
    summary: 'Cache list prices',
    status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' },
    project: { key: 'PLAT', name: 'Platform' },
    assignee: { displayName: 'Sam' },
    created: '2026-11-18T10:00:00.000+0000',
    updated: '2026-11-22T09:00:00.000+0000',
    customfield_10020: [
      { id: 1, name: 'Sprint 23', state: 'closed' },
      { id: 2, name: 'Sprint 24', state: 'active' },
    ],
  },
};

describe('Jira as tickets', () => {
  it('reads a site as typed, a category, a sprint and the Sprint field', () => {
    expect(siteHost('https://Team.Atlassian.net/jira/software/projects')).toBe('team.atlassian.net');
    expect(siteHost('not a site')).toBeNull();
    // The token goes in a header to this host: only a Jira Cloud site is taken.
    expect(siteHost('acme.jira.com')).toBe('acme.jira.com');
    for (const bad of ['jira.acme.atlassian.net.evil.com', 'evil.example', 'intranet.corp', '10.0.0.5', 'localhost', 'atlassian.net', 'me@evil.com/x.atlassian.net', 'evil.com#.atlassian.net', 'evil.com:443']) expect(siteHost(bad)).toBeNull();
    expect(jiraCategory('indeterminate', 'In Progress')).toBe('in-progress');
    expect(jiraCategory('indeterminate', 'Code review')).toBe('in-review');
    expect(jiraCategory('new', 'To Do')).toBe('todo');
    expect(jiraSprint([{ name: 'S9', state: 'future' }])).toEqual({ name: 'S9', current: false });
    expect(jiraSprint(null)).toBeNull();
    expect(sprintFieldId([{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }])).toBe('customfield_10020');
  });

  it('lists open issues assigned to the user, with the active sprint as current, signed with the email and token', async () => {
    const { calls, fetcher } = scripted({
      '/rest/api/3/field': { body: [{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }] },
      '/rest/api/3/search/jql': { body: { issues: [ISSUE] } },
      '/rest/api/3/issue/PLAT-12': { body: { fields: { description: DESCRIPTION, comment: { comments: [{ author: { displayName: 'Kim' }, created: '2026-11-21T00:00:00.000+0000', body: para('p95 ', { type: 'text', text: 'doubled', marks: [{ type: 'strong' }] }) }] } } } },
    });
    const source = jiraTicketSource(CREDS, fetcher);
    const list = await source.assignedToMe();
    expect(list.state).toBe('ready');
    const [t] = list.state === 'ready' ? list.value : [];
    expect(t).toMatchObject({ key: `jira:${SITE}/PLAT-12`, ref: 'PLAT-12', tracker: 'Jira', project: 'Platform', status: { name: 'In Review', category: 'in-review' }, priority: 2, priorityName: 'High', sprint: { name: 'Sprint 24', current: true }, url: `https://${SITE}/browse/PLAT-12` });
    const search = calls.find((c) => c.url.endsWith('/search/jql'))!;
    expect(JSON.parse(search.body!).fields).toContain('customfield_10020');
    expect(search.auth).toBe(`Basic ${Buffer.from('me@example.com:secret-token').toString('base64')}`);
    const detail = await source.read(t!);
    expect(detail).toEqual({ state: 'ready', value: { description: 'Why\n\n### Acceptance criteria\n\n- Hits the cache', criteria: ['Hits the cache'], comments: [{ author: 'Kim', at: Date.parse('2026-11-21T00:00:00.000Z'), body: 'p95 **doubled**' }] } });
  });

  it('says plainly when Jira refuses the token', async () => {
    const { fetcher } = scripted({ '/rest/api/3/search/jql': { status: 401, body: {} } });
    const answer = await jiraTicketSource(CREDS, fetcher).assignedToMe();
    expect(answer.state === 'unavailable' && answer.reason).toContain('did not accept the email and API token');
    expect(mapJiraDetail(null)).toEqual({ description: '', criteria: [], comments: [] });
  });
});

describe('Connecting Jira', () => {
  it('asks Jira who the token is before keeping anything, and never tells Settings the token', async () => {
    const store = memoryCredentials();
    let changed = 0;
    const { fetcher } = scripted({ '/rest/api/3/myself': { body: { displayName: 'Sam Example' } } });
    const jira = new JiraConnection(store, { fetcher, changed: () => changed++ });
    const view = await jira.connect({ site: `https://${SITE}/`, email: ' me@example.com ', token: 'secret-token' });
    expect(view).toEqual({ connected: true, site: SITE, email: 'me@example.com', name: 'Sam Example', storage: 'keystore', unavailable: null });
    expect(JSON.stringify(view)).not.toContain('secret-token');
    expect((await store.read()).jira?.token).toBe('secret-token');
    expect(await jira.ticketSource()).toBe(await jira.ticketSource());
    expect(changed).toBe(1);
    await jira.disconnect();
    expect(await jira.ticketSource()).toBeNull();
  });

  it('names the account by its id when Jira hides the name and the email', async () => {
    const { fetcher } = scripted({ '/rest/api/3/myself': { body: { displayName: '', emailAddress: null, accountId: 'acc-1' } } });
    const jira = new JiraConnection(memoryCredentials(), { fetcher, changed: () => {} });
    const view = await jira.connect({ site: `https://${SITE}/`, email: 'me@example.com', token: 't' });
    expect(view.name).toBe('acc-1');
  });

  it('refuses what cannot be right, and keeps nothing when Jira says no', async () => {
    const store = memoryCredentials();
    const { fetcher } = scripted({ '/rest/api/3/myself': { status: 401, body: {} } });
    const jira = new JiraConnection(store, { fetcher });
    await expect(jira.connect({ site: 'no', email: 'me@example.com', token: 't' })).rejects.toThrow('site');
    await expect(jira.connect({ site: 'jira.example.com', email: 'me@example.com', token: 't' })).rejects.toThrow('only to an atlassian.net or jira.com site');
    await expect(jira.connect({ site: SITE, email: 'nope', token: 't' })).rejects.toThrow('email');
    await expect(jira.connect({ site: SITE, email: 'me@example.com', token: ' ' })).rejects.toThrow('API token');
    await expect(jira.connect({ site: SITE, email: 'me@example.com', token: 't' })).rejects.toBeInstanceOf(Refused);
    expect((await store.read()).jira).toBeNull();
    await expect(new JiraConnection(store, { unavailable: 'sample data' }).connect(CREDS)).rejects.toThrow('sample data');
  });

  it('keeps the details sealed on disk under the app’s key', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-trackers-')), 'trackers.sealed');
    const key = randomBytes(32);
    await sealedCredentials(path, key).write({ jira: CREDS, linear: null });
    expect(readFileSync(path).toString('latin1')).not.toContain('secret-token');
    expect((await sealedCredentials(path, key).read()).jira).toEqual(CREDS);
    expect((await sealedCredentials(path, randomBytes(32)).read()).jira).toBeNull();
  });
});

describe('Moving a Jira issue', () => {
  const TRANSITIONS = {
    transitions: [
      { id: '21', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      { id: '31', name: 'Send to review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
      { id: '41', name: 'Finish', to: { name: 'Done', statusCategory: { key: 'done' } } },
      { id: '11', name: 'Back', to: { name: 'To Do', statusCategory: { key: 'new' } } },
    ],
  };
  const ticket = { ref: 'PLAT-7', key: `jira:${SITE}/PLAT-7`, status: { name: 'To Do', category: 'todo' } } as never;
  const path = '/rest/api/3/issue/PLAT-7/transitions';

  it('offers the transitions its workflow allows now, its own status left out, and makes the one picked', async () => {
    const { fetcher, calls } = scripted({ [`GET ${path}`]: { body: TRANSITIONS }, [`POST ${path}`]: { status: 204, body: null } });
    const source = jiraTicketSource(CREDS, fetcher);
    expect(await source.statuses(ticket)).toEqual({ state: 'ready', value: [{ name: 'In Progress', category: 'in-progress' }, { name: 'In Review', category: 'in-review' }, { name: 'Done', category: 'done' }] });
    expect(await source.move(ticket, 'In Review')).toEqual({ name: 'In Review', category: 'in-review' });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: JSON.stringify({ transition: { id: '31' } }) });
    await expect(source.move(ticket, 'Shipped')).rejects.toThrow('does not let PLAT-7 move to “Shipped”');
  });

  it('says Jira’s own reason when it refuses the move', async () => {
    const { fetcher } = scripted({ [`GET ${path}`]: { body: TRANSITIONS }, [`POST ${path}`]: { status: 400, body: { errorMessages: ['Resolution is required.'] } } });
    await expect(jiraTicketSource(CREDS, fetcher).move(ticket, 'Done')).rejects.toThrow('Jira said: Resolution is required.');
  });

  it('adds a comment written in Markdown as a document, and says Jira’s reason when it cannot', async () => {
    const { fetcher, calls } = scripted({ 'POST /rest/api/3/issue/PLAT-7/comment': { status: 201, body: { id: '9' } } });
    await jiraTicketSource(CREDS, fetcher).comment(ticket, 'Started on this.');
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ body: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Started on this.' }] }] } });
    await jiraTicketSource(CREDS, fetcher).comment(ticket, 'Fixed in **two** places:\n\n- `cache.ts`\n- the [guide](https://example.com)');
    const sent = JSON.parse(calls.at(-1)!.body!).body;
    expect(sent.content.map((n: { type: string }) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(sent.content[0].content[1]).toEqual({ type: 'text', text: 'two', marks: [{ type: 'strong' }] });
    // What is sent reads back as what was typed.
    expect(mapJiraDetail({ fields: { comment: { comments: [{ body: sent }] } } }).comments[0]!.body).toBe('Fixed in **two** places:\n\n- `cache.ts`\n- the [guide](https://example.com)');
    const refusing = scripted({ 'POST /rest/api/3/issue/PLAT-7/comment': { status: 403, body: { errorMessages: ['You cannot comment here.'] } } });
    await expect(jiraTicketSource(CREDS, refusing.fetcher).comment(ticket, 'x')).rejects.toThrow('You cannot comment here.');
  });
});

describe('a stored Jira site', () => {
  it('is held to the same rule as a typed one, so a hand-edited file sends the token nowhere else', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-trackers-')), 'trackers.sealed');
    const key = randomBytes(32);
    await sealedCredentials(path, key).write({ jira: { ...CREDS, site: 'evil.example' }, linear: null });
    expect((await sealedCredentials(path, key).read()).jira).toBeNull();
  });
});

describe('one Jira issue’s status, for a ticket that left the list', () => {
  it('asks for that issue’s status field only: its category says whether it is done; a refusal decides nothing', async () => {
    const { fetcher, calls } = scripted({
      '/rest/api/3/issue/PLAT-7': { body: { key: 'PLAT-7', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } },
      '/rest/api/3/issue/PLAT-8': { body: { key: 'PLAT-8', fields: { status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } } },
    });
    const source = jiraTicketSource(CREDS, fetcher);
    expect(await source.status({ ref: 'PLAT-7' } as Ticket)).toEqual({ state: 'ready', value: { name: 'Done', category: 'done' } });
    expect(calls[0]).toMatchObject({ url: `https://${SITE}/rest/api/3/issue/PLAT-7?fields=status`, method: 'GET' });
    expect(await source.status({ ref: 'PLAT-8' } as Ticket)).toEqual({ state: 'ready', value: { name: 'In Review', category: 'in-review' } });
    const missing = await source.status({ ref: 'PLAT-9' } as Ticket);
    expect(missing.state === 'unavailable' && missing.reason).toContain('no such page');
  });
});
