// The updater carries out `nodeUpdateStep` (shared/node-update.ts): when it looks, what it waits for, what a start is
// refused with meanwhile, and what it remembers of a failure. Every outside fact is a stand-in; nothing is installed.
import { describe, expect, test } from 'vitest';
import { NOT_BUSY, type NodeBusy } from '../shared/node-update.ts';
import type { UpdateOutcome } from './runner.ts';
import { NodeUpdateStore } from './store.ts';
import { NodeUpdater } from './updater.ts';

function node(over: { version?: string; desktops?: (string | null)[]; busy?: NodeBusy; service?: boolean; kind?: 'app' | 'node' } = {}) {
  const facts = { desktops: over.desktops ?? ['0.0.35'], busy: over.busy ?? NOT_BUSY, service: over.service ?? true };
  const store = new NodeUpdateStore();
  const runs: string[] = [];
  let finish: (result: { ok: true } | { ok: false; reason: string }) => void = () => undefined;
  let outcome: UpdateOutcome | null = null;
  const updater = new NodeUpdater({
    kind: over.kind ?? 'node',
    version: over.version ?? '0.0.34',
    name: () => 'Worker node 1',
    store,
    desktops: async () => facts.desktops,
    busy: async () => facts.busy,
    service: async () => facts.service,
    run: (target) => {
      runs.push(target);
      return new Promise((resolve) => (finish = resolve));
    },
    takeOutcome: () => {
      const left = outcome;
      outcome = null;
      return left;
    },
    log: () => undefined,
  });
  let told = 0;
  updater.onChange(() => told++);
  return { updater, store, runs, facts, finish: (r: { ok: true } | { ok: false; reason: string }) => finish(r), leave: (o: UpdateOutcome) => (outcome = o), told: () => told };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the node updater', () => {
  test('an idle node behind its desktops starts the update to exactly their version, and refuses starts meanwhile', async () => {
    const n = node({ desktops: ['0.0.34', '0.0.35', null] });
    await n.updater.check();
    expect(n.runs).toEqual(['0.0.35']);
    expect(n.updater.refusal()).toBe('Worker node 1 is updating to 0.0.35. Try again in a minute.');
    expect(n.updater.line()).toBe('Worker node 1 is updating to 0.0.35.');
    expect(n.told()).toBeGreaterThan(0);
  });

  test('nothing on a desktop, nothing with no desktop ahead of it', async () => {
    const app = node({ kind: 'app' });
    await app.updater.check();
    expect(app.runs).toEqual([]);
    expect(app.updater.note()).toBeNull();
    const ahead = node({ version: '0.0.36' });
    await ahead.updater.check();
    expect(ahead.runs).toEqual([]);
    expect(ahead.updater.line()).toBeNull();
  });

  test('waits for its work, naming it, and goes when it becomes idle', async () => {
    const n = node({ busy: { sessions: ['Fix login'], clones: 1, pushes: 0 } });
    await n.updater.check();
    expect(n.runs).toEqual([]);
    expect(n.updater.line()).toBe('Worker node 1 is on 0.0.34; it updates to 0.0.35 when its sessions and clones finish.');
    expect(n.updater.refusal()).toBeNull();
    n.facts.busy = NOT_BUSY;
    n.updater.maybeIdle();
    await settle();
    await n.updater.check();
    expect(n.runs).toEqual(['0.0.35']);
  });

  test('a node that is not waiting does not look again when something may have made it idle', async () => {
    const n = node({ desktops: ['0.0.34'] });
    await n.updater.check();
    n.facts.desktops = ['0.0.35'];
    n.updater.maybeIdle();
    await settle();
    expect(n.runs).toEqual([]);
  });

  test('a failure is remembered with its reason and not tried again until Update now, which waits only for running turns', async () => {
    const n = node();
    n.leave({ target: '0.0.35', ok: false, failed: { version: '0.0.35', reason: '0.0.35 was installed but did not answer. It went back to 0.0.34.' } });
    await n.updater.check();
    expect(n.runs).toEqual([]);
    expect((await n.store.current()).failed?.version).toBe('0.0.35');
    expect(n.updater.line()).toBe('Worker node 1 is on 0.0.34; its update to 0.0.35 failed: 0.0.35 was installed but did not answer. It went back to 0.0.34. It is tried again only by Update now.');
    n.facts.busy = { sessions: ['Fix login'], clones: 2, pushes: 1 };
    const waiting = await n.updater.updateNow();
    expect(waiting).toMatchObject({ to: '0.0.35', started: false, waitingFor: ['Fix login'] });
    n.facts.busy = { sessions: [], clones: 2, pushes: 1 };
    n.updater.maybeIdle();
    await settle();
    await n.updater.check();
    expect(n.runs).toEqual(['0.0.35']);
  });

  test('a runner that ends with the node still running clears the update and remembers why', async () => {
    const n = node();
    await n.updater.check();
    n.leave({ target: '0.0.35', ok: false, failed: { version: '0.0.35', reason: '0.0.35 has no build for worker nodes.', noBuild: true } });
    n.finish({ ok: true });
    await settle();
    await n.updater.check();
    expect(n.updater.refusal()).toBeNull();
    expect(n.updater.line()).toBe('Worker node 1 is on 0.0.34. 0.0.35 has no build for worker nodes.');
    const couldNotStart = node();
    await couldNotStart.updater.check();
    couldNotStart.finish({ ok: false, reason: 'Could not start the update: no user manager.' });
    await settle();
    await couldNotStart.updater.check();
    expect((await couldNotStart.store.current()).failed).toEqual({ version: '0.0.35', reason: 'Could not start the update: no user manager.' });
  });

  test('the setting off, or no service, holds it, and says how it moves', async () => {
    const off = node();
    await off.store.set({ follow: false });
    await off.updater.check();
    expect(off.runs).toEqual([]);
    expect(off.updater.line()).toMatch(/your desktops are on 0\.0\.35\. Keep this node on my desktops’ version is off/);
    const bare = node({ service: false });
    await bare.updater.check();
    expect(bare.runs).toEqual([]);
    expect(bare.updater.line()).toMatch(/runs without its service/);
  });

  test('a version that arrived clears the failure kept for it', async () => {
    const n = node({ version: '0.0.35', desktops: ['0.0.35'] });
    await n.store.set({ failed: { version: '0.0.35', reason: 'x' } });
    n.leave({ target: '0.0.35', ok: true });
    await n.updater.check();
    expect((await n.store.current()).failed).toBeNull();
  });

  test('Update now on a node that is current says so, and on an app that it is not a node', async () => {
    expect((await node({ version: '0.0.35' }).updater.updateNow()).text).toBe('Worker node 1 is on the newest version your desktops run.');
    expect((await node({ kind: 'app' }).updater.updateNow()).text).toMatch(/is not a worker node/);
  });
});
