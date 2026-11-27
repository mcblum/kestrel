import { describe, expect, test } from 'vitest';
import { accountUnknownOf, nodeGitFacts, type GitFactsSource } from './git-node.ts';

type Published = { computer: string; name: string | null; email: string | null; signs: boolean }[];
const CONNECTED = { account: { state: 'signed-in', email: 'sam@example.com' }, link: { state: 'connected', since: 1 } };

function source(published: () => Promise<Published>, opts: { projects?: unknown[]; feedRead?: boolean; connect?: unknown } = {}): GitFactsSource {
  const projects = opts.projects ?? [
    { id: 'a' },
    { id: 'b' },
    { id: 'account|web', away: true, elsewhere: { machines: [{ id: 'm', name: 'Mac mini' }], repos: ['github.com/acme/web'], folders: [] } },
  ];
  return {
    workspace: {
      view: async () => ({ projects }),
      repos: { ofProject: async (p: { id: string }) => (p.id === 'a' ? ['github.com/acme/api'] : ['git.example.org/team/app', 'github.com/acme/api']) },
      accountProjects: { feedMark: async () => (opts.feedRead === false ? null : { at: 1 }) },
    },
    connect: { publishedGit: published, view: () => opts.connect ?? CONNECTED },
  } as unknown as GitFactsSource;
}

describe("the node's part of kestrel-node git", () => {
  test("the repositories of this node's projects and the account's, once each; and the others' published git", async () => {
    const others = [{ computer: 'Mac mini', name: 'Sam Rivera', email: 'sam@example.com', signs: true }];
    expect(await nodeGitFacts(source(async () => others), 'Worker node 1')).toEqual({
      name: 'Worker node 1',
      repositories: ['git.example.org/team/app', 'github.com/acme/api', 'github.com/acme/web'],
      accountUnknown: null,
      others,
      othersUnknown: null,
    });
  });

  test('a node that has cloned nothing still answers the account’s repositories, at both their hosts', async () => {
    const away = (id: string, repos: string[]) => ({ id, away: true, elsewhere: { machines: [{ id: 'm', name: 'Mac mini' }], repos, folders: [] } });
    const facts = await nodeGitFacts(source(async () => [], { projects: [away('x', ['github.com/acme/shop']), away('y', ['gitlab.example.test/team/site', 'github.com/acme/shop'])] }), 'n');
    expect(facts).toMatchObject({ repositories: ['github.com/acme/shop', 'gitlab.example.test/team/site'], accountUnknown: null });
  });

  test('when the other computers cannot be read, says why and still answers the repositories', async () => {
    const facts = await nodeGitFacts(source(async () => Promise.reject(new Error('Kestrel Connect is not connected.'))), 'n');
    expect(facts).toMatchObject({ others: [], othersUnknown: 'Kestrel Connect is not connected.' });
    expect(facts.repositories).toHaveLength(3);
  });

  test('says the account’s projects are not known, never that there are none, until the projects feed was read', async () => {
    const facts = await nodeGitFacts(source(async () => [], { projects: [], feedRead: false }), 'n');
    expect(facts.repositories).toEqual([]);
    expect(facts.accountUnknown).toBe('The account’s projects are not read yet: the node reads them shortly after it connects.');
    expect(accountUnknownOf({ state: 'signed-out', reason: null }, { state: 'off' }, false)).toBe('This node is not in an account yet (`kestrel-node join`), so the account’s projects are not known.');
    expect(accountUnknownOf({ state: 'signed-in', email: 'e' }, { state: 'offline', reason: 'the service did not answer', retryAt: 1 }, false)).toBe(
      'The account’s projects are not known yet: Kestrel Connect is offline: the service did not answer.',
    );
    expect(accountUnknownOf({ state: 'signed-in', email: 'e' }, { state: 'offline', reason: 'x', retryAt: 1 }, true)).toBeNull();
  });
});
