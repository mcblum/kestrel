// The account data key on the desk (account-keys.ts) against the fake service: made once, opened,
// given to a device being let in, taken only from the device that let this one in, refused from a stranger, rotated when a device is
// removed (old records re-sealed, a removed device locked out of what is written after), recovered
// from the words.
import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyringSigned, newAccountKey, openRecord, recoveryKey, recoverySecretFromWords, sealRecord, signKeyring, unwrapKey, wrapKey } from '../account-key.ts';
import { newIdentity, publicIdentity, type Identity } from '../keys.ts';
import { Refused } from '../../refused.ts';
import { AccountKeys, type Keyring, type KeysTrust } from './account-keys.ts';
import { FakeHeldService } from './connect-fakes.ts';
import { HeldApi } from './held-api.ts';

interface Device {
  id: string;
  identity: Identity;
}

function desk(service: FakeHeldService, id = 'mac-1') {
  const identity = newIdentity();
  service.addDevice(id, id, 'desktop');
  let trust: KeysTrust | null = null;
  const keys = new AccountKeys({
    api: () => new HeldApi((method, path, body) => service.call(id, method, path, body)),
    me: () => ({ id, name: id, identity }),
    trust: () => trust,
    saveTrust: async (next) => void (trust = next),
    changed: () => undefined,
  });
  return { id, identity, keys, trust: () => trust };
}

/** What a phone holding the key does to let a computer in: a keyring with it, signed by the phone, and a copy. */
async function phoneLetsIn(service: FakeHeldService, iphone: Device, mac: { id: string; identity: Identity }): Promise<{ adk: Buffer; version: number }> {
  const { adk, keyring } = phoneOpens(service, iphone);
  const next: Keyring = { ...keyring, devices: [...keyring.devices, { id: mac.id, name: mac.id, kind: 'desktop', ...publicIdentity(mac.identity), addedBy: iphone.id, addedAt: 1 }] };
  const sealed = sealRecord(adk, 'keyring', 'keyring', 1, next);
  const version = service.keyring!.version + 1;
  await service.call(iphone.id, 'POST', '/keys/grant', { generation: 1, keyringVersion: version - 1, keyring: JSON.stringify({ sealed, signer: iphone.id, signature: signKeyring(iphone.identity, 1, version, sealed) }), deviceId: mac.id, wrapped: wrapKey(adk, publicIdentity(mac.identity).agreement, 1, mac.id) });
  return { adk, version };
}

function phone(service: FakeHeldService, id = 'phone-1'): Device {
  service.addDevice(id, id, 'phone');
  return { id, identity: newIdentity() };
}

/** What a phone does with its copy: opens it and reads the keyring. */
function phoneOpens(service: FakeHeldService, device: Device): { adk: Buffer; keyring: Keyring } {
  const copy = service.copies.get(device.id);
  if (!copy || !service.keyring) throw new Error('no copy');
  const adk = unwrapKey(copy.wrapped, createPrivateKey(device.identity.agreement.privateKey), copy.generation, device.id);
  const stored = JSON.parse(service.keyring.text);
  return { adk, keyring: openRecord(adk, stored.sealed, 'keyring', 'keyring', copy.generation) as Keyring };
}

describe('the account data key', () => {
  it('is made by the first device, with a copy for it, a keyring and a recovery copy', async () => {
    const service = new FakeHeldService();
    const mac = desk(service);
    await mac.keys.sync();
    expect(service.generation).toBe(1);
    expect(mac.keys.view()).toMatchObject({ state: 'ready', generation: 1, wordsToShow: true });
    const ready = mac.keys.ready()!;
    const words = mac.keys.words();
    expect(words).toHaveLength(24);
    const secret = recoverySecretFromWords(words.join(' '))!;
    expect(unwrapKey(service.recovery!.wrapped, recoveryKey(secret).privateKey, 1, 'recovery').equals(ready.adk)).toBe(true);
    const stored = JSON.parse(service.keyring!.text);
    expect(keyringSigned(publicIdentity(mac.identity).signing, stored.signature, 1, 1, stored.sealed)).toBe(true);
    expect((openRecord(ready.adk, stored.sealed, 'keyring', 'keyring', 1) as Keyring).devices.map((d) => d.id)).toEqual(['mac-1']);
    await mac.keys.wordsPutAway();
    expect(mac.keys.view()).toMatchObject({ wordsToShow: false });
  });

  it('is opened, not made again, on the next sync and by a restarted computer', async () => {
    const service = new FakeHeldService();
    const mac = desk(service);
    await mac.keys.sync();
    const adk = mac.keys.ready()!.adk;
    await mac.keys.sync();
    expect(service.generation).toBe(1);
    expect(mac.keys.ready()!.adk.equals(adk)).toBe(true);
  });

  it('is only made once when two computers start together; the second waits to be let in', async () => {
    const service = new FakeHeldService();
    const a = desk(service, 'mac-1');
    const b = desk(service, 'mac-2');
    await Promise.all([a.keys.sync(), b.keys.sync()]);
    expect(service.generation).toBe(1);
    const states = [a.keys.view().state, b.keys.view().state].sort();
    expect(states).toEqual(['locked', 'ready']);
  });

  it('is given to a device being let in, which can open it and check who gave it, under the version the grant says', async () => {
    const service = new FakeHeldService();
    const iphone = phone(service);
    const mac = desk(service, 'mac-1');
    await mac.keys.sync();
    expect(await mac.keys.grant({ id: iphone.id, name: 'iPhone', kind: 'phone', keys: publicIdentity(iphone.identity) })).toEqual({ generation: 1, keyringVersion: 2 });
    const opened = phoneOpens(service, iphone);
    expect(opened.adk.equals(mac.keys.ready()!.adk)).toBe(true);
    expect(opened.keyring.devices.map((d) => d.id)).toEqual(['mac-1', 'phone-1']);
    expect(service.keyring!.version).toBe(2);
  });

  it('is taken only from the device that let this computer in, at the version it named', async () => {
    const service = new FakeHeldService();
    const iphone = phone(service);
    const first = desk(service, 'mac-0');
    await first.keys.sync();
    await first.keys.grant({ id: iphone.id, name: 'iPhone', kind: 'phone', keys: publicIdentity(iphone.identity) });
    const mac = desk(service, 'mac-1');
    await mac.keys.sync();
    expect(mac.keys.view()).toMatchObject({ state: 'locked', reason: expect.stringContaining('type the code shown here') });
    const { adk, version } = await phoneLetsIn(service, iphone, mac);
    // Given a copy but not yet told by whom: nothing it trusts signed the keyring, so it waits.
    await mac.keys.sync();
    expect(mac.keys.ready()).toBeNull();
    const signing = publicIdentity(iphone.identity).signing;
    // A welcome naming another signer, or another version, is refused.
    await expect(mac.keys.acceptFrom({ id: 'mac-0', signing: publicIdentity(first.identity).signing, generation: 1, keyringVersion: version })).rejects.toThrow('not given by a device it knows');
    await expect(mac.keys.acceptFrom({ id: iphone.id, signing, generation: 1, keyringVersion: version + 1 })).rejects.toThrow('changed while this device was being let in');
    await mac.keys.acceptFrom({ id: iphone.id, signing, generation: 1, keyringVersion: version });
    expect(mac.keys.view().state).toBe('ready');
    expect(mac.keys.ready()!.adk.equals(adk)).toBe(true);
    // From now on it trusts the keyring's devices, so it opens on its own.
    mac.keys.reset();
    await mac.keys.sync();
    expect(mac.keys.view().state).toBe('ready');
    expect(mac.keys.member(iphone.id)).toBe(signing);
  });

  it('is refused from the device that let it in when the keyring does not list this computer with its own keys', async () => {
    const service = new FakeHeldService();
    const iphone = phone(service);
    const first = desk(service, 'mac-0');
    await first.keys.sync();
    await first.keys.grant({ id: iphone.id, name: 'iPhone', kind: 'phone', keys: publicIdentity(iphone.identity) });
    const mac = desk(service, 'mac-1');
    await mac.keys.sync();
    // The keyring lists other keys under this computer's id (a relay that swapped them).
    const { version } = await phoneLetsIn(service, iphone, { id: mac.id, identity: newIdentity() });
    service.copies.set(mac.id, { generation: 1, wrapped: wrapKey(phoneOpens(service, iphone).adk, publicIdentity(mac.identity).agreement, 1, mac.id) });
    await expect(mac.keys.acceptFrom({ id: iphone.id, signing: publicIdentity(iphone.identity).signing, generation: 1, keyringVersion: version })).rejects.toThrow('not given by a device it knows');
    expect(mac.keys.ready()).toBeNull();
  });

  it('is refused when it was given by a device this computer does not know (a service that made its own)', async () => {
    const service = new FakeHeldService();
    const mac = desk(service, 'mac-1');
    await mac.keys.sync();
    const stranger = desk(service, 'mac-2');
    // The "service" makes a key of its own and wraps it for mac-2, signing the keyring with a key it made.
    const forged = newAccountKey();
    const evil = newIdentity();
    const keyring: Keyring = { v: 1, generation: 1, idKey: 'aWQ', recovery: { agreement: 'x', secret: 'y' }, devices: [] };
    const sealed = sealRecord(forged, 'keyring', 'keyring', 1, keyring);
    service.keyring = { version: 1, text: JSON.stringify({ sealed, signer: 'mac-1', signature: signKeyring(evil, 1, 1, sealed) }) };
    service.copies.set(stranger.id, { generation: 1, wrapped: wrapKey(forged, publicIdentity(stranger.identity).agreement, 1, stranger.id) });
    await stranger.keys.sync();
    expect(stranger.keys.view()).toMatchObject({ state: 'locked' });
    expect(stranger.keys.ready()).toBeNull();
  });

  it('is rotated when a device is removed: the removed device cannot open what is sealed after, old records are re-sealed, the old key dropped', async () => {
    const service = new FakeHeldService();
    const iphone = phone(service);
    const mac = desk(service, 'mac-1');
    await mac.keys.sync();
    await mac.keys.grant({ id: iphone.id, name: 'iPhone', kind: 'phone', keys: publicIdentity(iphone.identity) });
    const oldWords = mac.keys.words().join(' ');
    const old = mac.keys.ready()!;
    const record = sealRecord(old.adk, 'record', 'r1', 1, { text: 'held before removal' });
    await service.call(mac.id, 'PUT', '/held/records/r1', { generation: 1, session: 's', project: 'p', body: record });
    await mac.keys.wordsPutAway();

    service.removeDevice(iphone.id);
    await mac.keys.sync();

    expect(service.generation).toBe(2);
    expect(mac.keys.view()).toMatchObject({ state: 'ready', generation: 2, wordsToShow: true, changedBecause: ['phone-1'] });
    const now = mac.keys.ready()!;
    expect(now.adk.equals(old.adk)).toBe(false);
    expect(now.idKey.equals(old.idKey)).toBe(true);
    expect(service.copies.has(iphone.id)).toBe(false);
    // What is sealed from now on is not readable with the old key the removed phone kept.
    expect(() => openRecord(old.adk, sealRecord(now.adk, 'record', 'r2', 2, { text: 'after' }), 'record', 'r2', 2)).toThrow();
    // The old words no longer open the account key.
    await expect(mac.keys.recover(oldWords)).rejects.toBeInstanceOf(Refused);
    // The key for generation 1 is reached through the previous key.
    expect(mac.keys.keyFor(1).equals(old.adk)).toBe(true);
    expect(await mac.keys.reseal()).toBe(1);
    const resealed = service.records.get('r1')!;
    expect(resealed.generation).toBe(2);
    expect(openRecord(now.adk, resealed.body, 'record', 'r1', 2)).toEqual({ text: 'held before removal' });
    expect(service.previous).toEqual([]);
  });

  it('lets a computer in with the recovery words, and refuses wrong ones', async () => {
    const service = new FakeHeldService();
    const first = desk(service, 'mac-1');
    await first.keys.sync();
    const words = first.keys.words().join(' ');
    const fresh = desk(service, 'mac-2');
    await fresh.keys.sync();
    expect(fresh.keys.view().state).toBe('locked');
    await expect(fresh.keys.recover('not twenty four words')).rejects.toThrow(/24 recovery words/);
    const other = desk(new FakeHeldService(), 'x');
    await other.keys.sync();
    await expect(fresh.keys.recover(other.keys.words().join(' '))).rejects.toThrow(/not your account/);
    await fresh.keys.recover(words.toUpperCase());
    expect(fresh.keys.view().state).toBe('ready');
    expect(fresh.keys.ready()!.adk.equals(first.keys.ready()!.adk)).toBe(true);
    expect(service.copies.has('mac-2')).toBe(true);
    // And it opens on its own next time.
    const again = fresh.keys;
    again.reset();
    await again.sync();
    expect(again.view().state).toBe('ready');
  });
});
