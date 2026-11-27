// A worker node and the recovery words (worker-nodes.md, W5): never shown on it, never typed into it, and so never
// made there: a node does not make the account's first key, and it signs in by a device grant, not the browser.
import { describe, expect, test } from 'vitest';
import { recoveryWordsRefusal } from '../../shared/connect.ts';
import { memorySettings } from '../../suggestions/prefs.ts';
import { until } from '../../test-agent.ts';
import { NO_KEY_YET_HERE } from './account-keys.ts';
import { FakeIdentity, FakeService, fakeListener, tokensFor } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { memoryVault } from './vault.ts';

const WORDS = Array.from({ length: 24 }, () => 'abandon').join(' ');

async function connectAs(kind: 'app' | 'node', signedIn = true) {
  const service = new FakeService();
  const settings = memorySettings();
  await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
  const connect = new KestrelConnect({ kind, vault: memoryVault({ tokens: signedIn ? tokensFor(0, Date.now()) : null, device: null }), identity: new FakeIdentity(), service, settings, computerName: 'Worker node 1', listen: fakeListener().listen });
  await connect.start();
  return { connect, service };
}

describe('recovery words on a worker node', () => {
  test('are never shown, put away or typed there, each refused with the reason', async () => {
    // Arrange
    const { connect } = await connectAs('node');
    const reason = recoveryWordsRefusal('node')!;
    // Act and assert
    expect(() => connect.recoveryWords()).toThrow(reason);
    await expect(connect.recoveryPutAway()).rejects.toThrow(reason);
    await expect(connect.recover(WORDS)).rejects.toThrow(reason);
    await expect(connect.keys.recover(WORDS)).rejects.toThrow(reason);
    expect(reason).toContain('kestrel-node join');
    await connect.close();
  });

  test('the app is unchanged: it may show and take the words', () => {
    expect(recoveryWordsRefusal('app')).toBeNull();
  });

  test('a node does not make the account’s first key (and its words); it says to start on a computer with a screen', async () => {
    const { connect, service } = await connectAs('node');
    await until(() => service.sockets.length === 1, 'the node dials');
    service.welcome(service.last(), Date.now() + 300_000);
    await until(() => connect.view().keys.state === 'failed', 'the key is read');
    expect(connect.view().keys).toEqual({ state: 'failed', reason: NO_KEY_YET_HERE });
    expect(service.held.generation).toBeNull();
    expect(service.registered).toHaveLength(1);
    expect(service.held.devices.get(service.registered[0]!.id)?.kind).toBe('node');
    await connect.close();
  });
});

describe('how a node signs in', () => {
  test('never through the browser: the loopback sign-in is refused with what to do instead', async () => {
    const { connect } = await connectAs('node', false);
    await expect(connect.signIn()).rejects.toThrow('kestrel-node join');
    await connect.close();
  });

  test('the app never by a device code', async () => {
    const { connect } = await connectAs('app', false);
    await expect(connect.signInWithCode()).rejects.toThrow('through the browser');
    await connect.close();
  });
});
