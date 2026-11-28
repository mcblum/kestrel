// What a computer offers carries a worker node's settings and facts for its page, and only a node's, cleaned as the rest.
import { describe, expect, test } from 'vitest';
import type { NodePublished } from '../shared/node-facts.ts';
import { offersOf, type OffersSettings } from './offers.ts';

const node: NodePublished = {
  settings: { name: 'Worker node 1', remoteStarts: true, agent: 'claude', model: '', mode: 'ask', autoReviews: false, projects: 'every', push: true, followDesktopVersion: true },
  facts: { agents: { claude: 'Can run', codex: 'Can run', opencode: 'Can run' }, git: 'key made', sandbox: 'Available', lingering: 'On', freeDisk: '9 GB free.', projects: 'Kept in /home/someone/.kestrel/projects' },
};
const settings: OffersSettings = { allowed: true, presets: [], uiState: null, projects: [], node };
const source = { here: 'Worker node 1', home: '/home/someone', user: 'someone' };

describe('offersOf', () => {
  test("a worker node's record carries its settings and facts, cleaned", () => {
    const offers = offersOf({ ...source, kind: 'node' }, settings, [], []);
    expect(offers.node?.settings).toEqual(node.settings);
    expect(offers.node?.facts.projects).toBe('Kept in ~/.kestrel/projects');
  });

  test("a desktop's never does", () => {
    expect(offersOf({ ...source, kind: 'app' }, settings, [], []).node).toBeUndefined();
  });
});
