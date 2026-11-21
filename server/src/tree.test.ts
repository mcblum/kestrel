// How links become rows (tree.ts): only a delegation makes a child. A handoff and a fork are
// lineage: where a session came from, never whose child it is (Matt, 2026-11-20).
import { describe, expect, it } from 'vitest';
import type { Link } from './model.ts';
import { buildTree, childLinkOf, depthOf, handoffChain, rootOf, startLinkOf, subtreeIds } from './tree.ts';

const link = (parentId: string, childId: string, kind: Link['kind']): Link => ({ id: `${parentId}-${childId}`, parentId, childId, kind });

describe('a delegation', () => {
  const links = [link('a', 'b', 'delegate'), link('b', 'c', 'delegate')];

  it('draws the delegate under the session that delegated to it', () => {
    expect(buildTree(['a', 'b', 'c'], links)).toEqual([
      { sessionId: 'a', via: null, movedFrom: null, children: [{ sessionId: 'b', via: 'delegate', movedFrom: null, children: [{ sessionId: 'c', via: 'delegate', movedFrom: null, children: [] }] }] },
    ]);
  });

  it('is what a tree, its top and its depth are made of', () => {
    expect(subtreeIds('a', links)).toEqual(['a', 'b', 'c']);
    expect(rootOf('c', links)).toBe('a');
    expect(depthOf('c', links)).toBe(2);
  });
});

describe('a handoff', () => {
  const links = [link('a', 'b', 'handoff')];

  it('makes siblings: the new session is a row of its own, marked with where it came from', () => {
    expect(buildTree(['a', 'b'], links)).toEqual([
      { sessionId: 'a', via: null, movedFrom: null, children: [] },
      { sessionId: 'b', via: null, movedFrom: 'a', children: [] },
    ]);
  });

  it('is not part of the caller’s tree, and starts no level', () => {
    expect(subtreeIds('a', links)).toEqual(['a']);
    expect(rootOf('b', links)).toBe('b');
    expect(depthOf('b', links)).toBe(0);
    expect(childLinkOf('b', links)).toBeUndefined();
  });

  it('is still how the new session was started, so it is confined and filed as one', () => {
    expect(startLinkOf('b', links)?.kind).toBe('handoff');
    expect(startLinkOf('b', [link('a', 'b', 'fork')])).toBeUndefined();
  });

  it('keeps a delegate that handed its task off out of its orchestrator’s tree from there on', () => {
    const mixed = [link('o', 'd', 'delegate'), link('d', 'h', 'handoff')];
    expect(subtreeIds('o', mixed)).toEqual(['o', 'd']);
    expect(buildTree(['o', 'd', 'h'], mixed).map((n) => n.sessionId)).toEqual(['o', 'h']);
  });

  it('is counted along the chain it came down', () => {
    const chain = [link('a', 'b', 'handoff'), link('b', 'c', 'handoff'), link('x', 'a', 'delegate')];
    expect(handoffChain('c', chain)).toBe(2);
    expect(handoffChain('a', chain)).toBe(0);
  });
});
