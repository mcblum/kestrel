import { describe, expect, it } from 'vitest';
import { DEFAULT_NODE_PROJECT_PREFS, MIRROR_MODE_LABEL, nodePushStep, PUSH_LABEL, pushFailedText, pushSaid, sanitizeNodeProjectPrefs, type NodePushFacts } from './node-push.ts';

const facts = (over: Partial<NodePushFacts> = {}): NodePushFacts => ({ kind: 'node', on: true, session: { branch: 'kestrel/fix-login' }, base: 'main', origin: true, keptOff: false, ahead: 2, ...over });

describe('whether a node pushes a session’s branch when a turn ends', () => {
  it('pushes the session’s own branch to the same name on origin, never forced', () => {
    expect(nodePushStep(facts())).toEqual({ push: true, branch: 'kestrel/fix-login', refspec: 'refs/heads/kestrel/fix-login:refs/heads/kestrel/fix-login' });
  });

  it('never on a desktop: there the person pushes', () => {
    expect(nodePushStep(facts({ kind: 'app' }))).toEqual({ push: false, why: 'not-a-node' });
  });

  it('not when the node’s setting is off', () => {
    expect(nodePushStep(facts({ on: false }))).toEqual({ push: false, why: 'off' });
  });

  it('never a branch the session did not make: a guest, a review of somebody else’s request, a sidebar, or none', () => {
    expect(nodePushStep(facts({ session: { branch: null } }))).toEqual({ push: false, why: 'not-its-branch' });
    expect(nodePushStep(facts({ session: { branch: 'x', hostId: 'host' } }))).toEqual({ push: false, why: 'not-its-branch' });
    expect(nodePushStep(facts({ session: { branch: 'x', review: true } }))).toEqual({ push: false, why: 'not-its-branch' });
    expect(nodePushStep(facts({ session: { branch: 'x', aside: true } }))).toEqual({ push: false, why: 'not-its-branch' });
  });

  it('never the base branch', () => {
    expect(nodePushStep(facts({ session: { branch: 'main' }, base: 'main' }))).toEqual({ push: false, why: 'base' });
  });

  it('nothing for a project kept off Kestrel Connect, or with no origin', () => {
    expect(nodePushStep(facts({ keptOff: true }))).toEqual({ push: false, why: 'kept-off' });
    expect(nodePushStep(facts({ origin: false }))).toEqual({ push: false, why: 'no-origin' });
  });

  it('nothing when origin already has every commit', () => {
    expect(nodePushStep(facts({ ahead: 0 }))).toEqual({ push: false, why: 'nothing' });
  });
});

describe('a refused push', () => {
  it('is said with git’s own line', () => {
    const stderr = 'To example.test:acme/shop.git\n ! [rejected]        kestrel/x -> kestrel/x (non-fast-forward)\nerror: failed to push some refs to \'example.test:acme/shop.git\'\n';
    expect(pushSaid(stderr)).toBe('! [rejected]        kestrel/x -> kestrel/x (non-fast-forward)');
    expect(pushSaid('fatal: Could not read from remote repository.\n')).toBe('fatal: Could not read from remote repository.');
    expect(pushSaid('')).toBe('');
    expect(pushFailedText('kestrel/x', 'fatal: Could not read from remote repository.')).toBe('Could not push `kestrel/x` to `origin`: fatal: Could not read from remote repository.');
    expect(pushFailedText('kestrel/x', '')).toBe('Could not push `kestrel/x` to `origin`: git did not say why.');
  });
});

describe('the node’s Projects settings', () => {
  it('clones every project and pushes by default', () => {
    expect(DEFAULT_NODE_PROJECT_PREFS).toEqual({ projects: 'every', push: true });
    expect(MIRROR_MODE_LABEL).toEqual({ every: 'Clone every project of the account', 'on-start': 'Clone a project when a session starts in it' });
    expect(PUSH_LABEL).toBe('Push each session’s branch when a turn ends');
  });

  it('reads anything unknown as the default for that part', () => {
    expect(sanitizeNodeProjectPrefs({ projects: 'on-start', push: false })).toEqual({ projects: 'on-start', push: false });
    expect(sanitizeNodeProjectPrefs({ projects: 'all', push: 'yes' })).toEqual(DEFAULT_NODE_PROJECT_PREFS);
    expect(sanitizeNodeProjectPrefs(null)).toEqual(DEFAULT_NODE_PROJECT_PREFS);
  });
});
