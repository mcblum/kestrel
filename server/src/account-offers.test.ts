// This computer's copy of the account's offers records: a worker node's answer to a change of its settings is held at
// once, and the next reading of the feed replaces it.
import { describe, expect, test } from 'vitest';
import { AccountOffers } from './account-offers.ts';
import { memoryPersistence } from './persistence/memory.ts';
import type { HeldOffers } from './shared/machine-offers.ts';
import type { NodePublished } from './shared/node-facts.ts';

const held: HeldOffers = { machine: { id: 'node-1', name: 'Worker node 1' }, made: 1, offers: { here: 'Worker node 1', allowed: true, agents: ['claude'], presets: [], start: { agent: 'claude', model: '', effort: '', fast: false, permission: 'ask' }, providers: [], missing: [], projects: [] } };
const node: NodePublished = {
  settings: { name: 'Worker node 1', remoteStarts: true, agent: 'claude', model: '', mode: 'ask', autoReviews: false, projects: 'every', push: false, followDesktopVersion: true },
  facts: { agents: { claude: 'Can run', codex: 'Can run', opencode: 'Can run' }, git: '', sandbox: 'Available', lingering: 'On', freeDisk: '9 GB free.', projects: '' },
};

describe('takeNodeAnswer', () => {
  test("holds the node's answer in its record and tells the windows", async () => {
    const offers = new AccountOffers(memoryPersistence());
    await offers.apply({ offers: [held], gone: [], members: ['node-1'], whole: true, mark: null });
    const told: unknown[] = [];
    offers.onChange((view) => told.push(view['node-1']?.offers.node));
    expect(await offers.takeNodeAnswer('node-1', node)).toBe(true);
    expect((await offers.view())['node-1']!.offers.node).toEqual(node);
    expect(told).toEqual([node]);
    // The same answer again changes nothing.
    expect(await offers.takeNodeAnswer('node-1', node)).toBe(false);
    // The node's own record, read from the feed, replaces it.
    await offers.apply({ offers: [held], gone: [], members: ['node-1'], whole: true, mark: null });
    expect((await offers.view())['node-1']!.offers.node).toBeUndefined();
  });

  test('holds nothing for a computer with no record', async () => {
    const offers = new AccountOffers(memoryPersistence());
    expect(await offers.takeNodeAnswer('node-1', node)).toBe(false);
    expect(await offers.view()).toEqual({});
  });
});
