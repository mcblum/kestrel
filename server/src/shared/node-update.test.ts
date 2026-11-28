import { describe, expect, test } from 'vitest';
import { asNodeUpdateNote, canUpdateNow, compareVersions, HELD_NO_SERVICE, HELD_OFF, newestVersion, nodeUpdateLine, nodeUpdateStep, noteOfStep, NOT_BUSY, updatingRefusal, type NodeUpdateFacts } from './node-update.ts';

const facts = (over: Partial<NodeUpdateFacts> = {}): NodeUpdateFacts => ({ kind: 'node', version: '0.0.34', desktops: ['0.0.35'], on: true, asked: false, busy: NOT_BUSY, failed: null, service: true, updating: null, ...over });

describe('comparing versions', () => {
  test('a beta is older than its release and newer than the release before', () => {
    expect(compareVersions('0.0.35-beta.2', '0.0.35')).toBeLessThan(0);
    expect(compareVersions('0.0.35', '0.0.35-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('0.0.35-beta.1', '0.0.34')).toBeGreaterThan(0);
    expect(compareVersions('0.0.35-beta.10', '0.0.35-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.0.99')).toBeGreaterThan(0);
    expect(compareVersions('0.0.35', '0.0.35')).toBe(0);
  });

  test('something that is not a version is older than any, and the newest ignores it', () => {
    expect(compareVersions('', '0.0.1')).toBeLessThan(0);
    expect(newestVersion([null, '0.0.34', 'nonsense', '0.0.35-beta.1', undefined])).toBe('0.0.35-beta.1');
    expect(newestVersion([null, ''])).toBeNull();
  });
});

describe('nodeUpdateStep', () => {
  test('moves to the newest version a desktop runs, when idle', () => {
    expect(nodeUpdateStep(facts({ desktops: ['0.0.34', '0.0.35', null] }))).toEqual({ do: 'update', to: '0.0.35' });
  });

  test('never on a desktop, never with no desktop, never down or sideways', () => {
    expect(nodeUpdateStep(facts({ kind: 'app' }))).toEqual({ do: 'stay', why: 'not-a-node' });
    expect(nodeUpdateStep(facts({ desktops: [] }))).toEqual({ do: 'stay', why: 'no-desktop' });
    expect(nodeUpdateStep(facts({ desktops: [null] }))).toEqual({ do: 'stay', why: 'no-desktop' });
    expect(nodeUpdateStep(facts({ version: '0.0.36', desktops: ['0.0.35'] }))).toEqual({ do: 'stay', why: 'current' });
    expect(nodeUpdateStep(facts({ version: '0.0.35', desktops: ['0.0.35'] }))).toEqual({ do: 'stay', why: 'current' });
    // A node on a release does not move to that release's beta.
    expect(nodeUpdateStep(facts({ version: '0.0.35', desktops: ['0.0.35-beta.3'] }))).toEqual({ do: 'stay', why: 'current' });
    expect(nodeUpdateStep(facts({ version: '', desktops: ['0.0.35'] }))).toEqual({ do: 'stay', why: 'current' });
  });

  test('a desktop on a beta brings its nodes to that beta', () => {
    expect(nodeUpdateStep(facts({ version: '0.0.34', desktops: ['0.0.35-beta.1'] }))).toEqual({ do: 'update', to: '0.0.35-beta.1' });
  });

  test('waits for running turns, clones and pushes, naming them', () => {
    const busy = { sessions: ['Fix login'], clones: 1, pushes: 0 };
    expect(nodeUpdateStep(facts({ busy }))).toEqual({ do: 'wait', to: '0.0.35', busy });
  });

  test('Update now waits only for running turns, and tries a failed version again', () => {
    expect(nodeUpdateStep(facts({ asked: true, busy: { sessions: [], clones: 2, pushes: 1 } }))).toEqual({ do: 'update', to: '0.0.35' });
    expect(nodeUpdateStep(facts({ asked: true, busy: { sessions: ['A'], clones: 2, pushes: 1 } }))).toEqual({ do: 'wait', to: '0.0.35', busy: { sessions: ['A'], clones: 0, pushes: 0 } });
    expect(nodeUpdateStep(facts({ asked: true, failed: { version: '0.0.35', reason: 'x' } }))).toEqual({ do: 'update', to: '0.0.35' });
    expect(nodeUpdateStep(facts({ asked: true, on: false }))).toEqual({ do: 'update', to: '0.0.35' });
  });

  test('a version that failed, or has no build, is not tried again on its own', () => {
    expect(nodeUpdateStep(facts({ failed: { version: '0.0.35', reason: 'The checksum did not match.' } }))).toEqual({ do: 'stay', why: 'failed', to: '0.0.35', reason: 'The checksum did not match.' });
    expect(nodeUpdateStep(facts({ failed: { version: '0.0.35', reason: '0.0.35 has no build for worker nodes.', noBuild: true } }))).toMatchObject({ do: 'stay', why: 'no-build' });
    // A newer desktop version is a new target, failed or not.
    expect(nodeUpdateStep(facts({ desktops: ['0.0.36'], failed: { version: '0.0.35', reason: 'x' } }))).toEqual({ do: 'update', to: '0.0.36' });
  });

  test('the setting off, or no service to restart it, keeps it where it is', () => {
    expect(nodeUpdateStep(facts({ on: false }))).toEqual({ do: 'stay', why: 'off', to: '0.0.35' });
    expect(nodeUpdateStep(facts({ service: false }))).toEqual({ do: 'stay', why: 'no-service', to: '0.0.35' });
  });

  test('an update under way is left to finish', () => {
    expect(nodeUpdateStep(facts({ updating: '0.0.35' }))).toEqual({ do: 'stay', why: 'updating', to: '0.0.35' });
  });
});

describe('the line every screen shows', () => {
  const line = (f: Partial<NodeUpdateFacts>) => nodeUpdateLine('Worker node 1', '0.0.34', noteOfStep(nodeUpdateStep(facts(f))));

  test('waiting, updating, failed, no build, held, and nothing', () => {
    expect(line({ busy: { sessions: ['A'], clones: 0, pushes: 0 } })).toBe('Worker node 1 is on 0.0.34; it updates to 0.0.35 when its sessions finish.');
    expect(line({ busy: { sessions: ['A'], clones: 1, pushes: 2 } })).toBe('Worker node 1 is on 0.0.34; it updates to 0.0.35 when its sessions, clones and pushes finish.');
    expect(line({ busy: { sessions: [], clones: 1, pushes: 0 } })).toBe('Worker node 1 is on 0.0.34; it updates to 0.0.35 when its clones finish.');
    expect(line({})).toBe('Worker node 1 is updating to 0.0.35.');
    expect(line({ failed: { version: '0.0.35', reason: 'Could not fetch the bundle' } })).toBe('Worker node 1 is on 0.0.34; its update to 0.0.35 failed: Could not fetch the bundle. It is tried again only by Update now.');
    expect(line({ failed: { version: '0.0.35', reason: 'x', noBuild: true } })).toBe('Worker node 1 is on 0.0.34. 0.0.35 has no build for worker nodes.');
    expect(line({ on: false })).toBe(`Worker node 1 is on 0.0.34; your desktops are on 0.0.35. ${HELD_OFF}`);
    expect(line({ service: false })).toBe(`Worker node 1 is on 0.0.34; your desktops are on 0.0.35. ${HELD_NO_SERVICE}`);
    expect(line({ version: '0.0.35' })).toBeNull();
  });

  test('Update now is offered where there is something to do, and a start meanwhile is refused', () => {
    expect(canUpdateNow({ to: '0.0.35', state: 'failed', reason: 'x' })).toBe(true);
    expect(canUpdateNow({ to: '0.0.35', state: 'updating' })).toBe(false);
    expect(canUpdateNow(null)).toBe(false);
    expect(updatingRefusal('Worker node 1', '0.0.35')).toBe('Worker node 1 is updating to 0.0.35. Try again in a minute.');
  });

  test('a note read from outside is checked', () => {
    expect(asNodeUpdateNote({ to: '0.0.35', state: 'waiting', busy: { sessions: ['A', 3], clones: 1, pushes: -1 } })).toEqual({ to: '0.0.35', state: 'waiting', busy: { sessions: ['A'], clones: 1, pushes: 0 } });
    expect(asNodeUpdateNote({ to: 'latest', state: 'waiting' })).toBeNull();
    expect(asNodeUpdateNote({ to: '0.0.35', state: 'gone' })).toBeNull();
    expect(asNodeUpdateNote('0.0.35')).toBeNull();
  });
});
