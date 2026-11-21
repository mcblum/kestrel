import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { sqlitePersistence } from '../persistence/sqlite.ts';
import type { Persistence } from '../persistence/types.ts';
import { Workspace } from '../workspace.ts';
import { Onboarding } from './setup.ts';
import { onboardingRoute } from './api.ts';

describe.each([
  ['memory', () => memoryPersistence()],
  ['sqlite', () => sqlitePersistence(':memory:')],
])('onboarding with %s', (_name, create) => {
  let db: Persistence;
  let workspace: Workspace;
  beforeEach(() => { db = create(); workspace = new Workspace(db); });
  afterEach(() => db.close());

  test('a fresh workspace keeps its place after adding projects and recreating the service', async () => {
    expect(await workspace.onboarding.read()).toEqual({ step: 'welcome' });
    await workspace.onboarding.save('projects');
    await workspace.addProject({ id: 'one', name: 'One', path: '/one', isGit: true });
    expect(await new Onboarding(db).read()).toEqual({ step: 'projects' });
    await workspace.onboarding.save('complete');
    expect(await new Onboarding(db).read()).toEqual({ step: 'complete' });
  });

  test('existing projects bypass setup and deleting them does not restart it', async () => {
    await workspace.addProject({ id: 'one', name: 'One', path: '/one', isGit: true });
    expect(await workspace.onboarding.read()).toEqual({ step: 'complete' });
    await workspace.removeProject('one');
    expect(await workspace.onboarding.read()).toEqual({ step: 'complete' });
  });

  test('a workspace with only a session bypasses setup, including archived work', async () => {
    await workspace.addSession({ id: 'one', title: 'One', agent: 'claude', startedIn: null });
    await workspace.setState('one', 'done', 'Finished');
    await workspace.setArchived('session', 'one', true);
    expect((await workspace.state()).sessions).toHaveLength(0);
    expect(await workspace.onboarding.read()).toEqual({ step: 'complete' });
  });

  test('skip is durable even with no projects, and setup can be explicitly reopened', async () => {
    await workspace.onboarding.save('complete');
    expect(await new Onboarding(db).read()).toEqual({ step: 'complete' });
    await workspace.onboarding.save('welcome');
    expect(await new Onboarding(db).read()).toEqual({ step: 'welcome' });
  });

  test('an initial read cannot overwrite a simultaneous progress save', async () => {
    await Promise.all([workspace.onboarding.read(), workspace.onboarding.save('agents')]);
    expect(await workspace.onboarding.read()).toEqual({ step: 'agents' });
  });

  test('the route validates progress and does not consume unrelated bodies', async () => {
    const route = (method: string, body: Record<string, unknown>) => onboardingRoute(['api', 'onboarding'], method, async () => body, workspace.onboarding);
    expect(await route('PUT', { step: 'projects' })).toEqual({ status: 200, body: { step: 'projects' } });
    // Every step of the guide is progress that can be saved, Notifications (0.0.21) included.
    for (const step of ['welcome', 'agents', 'notifications', 'ready', 'projects']) expect(await route('PUT', { step })).toEqual({ status: 200, body: { step } });
    for (const step of [null, 'unknown', 1, {}, ['complete']]) expect((await route('PUT', { step }))?.status).toBe(400);
    expect(await route('GET', {})).toEqual({ status: 200, body: { step: 'projects' } });
    expect(await onboardingRoute(['api', 'state'], 'PUT', async () => { throw new Error('must not read'); }, workspace.onboarding)).toBeNull();
  });
});
