// A device's name is the user's to give (kestrel-connect.md, "A device's name is the user's to give"; Matt,
// 2026-11-24: "Instead of Laptop-A1B2C3 for work I'd like to just say 'Work Laptop'"). Two desks on one fake
// service with no network: this computer's name kept with Connect off and given at registration, a rename
// reaching the service and the other devices, one kept until the service takes it, a rename made elsewhere
// taken as this computer's own, and renaming another device of the account.
import { afterEach, describe, expect, it } from 'vitest';
import { memorySettings } from '../../suggestions/prefs.ts';
import { until } from '../../test-agent.ts';
import { connectRoute } from './api.ts';
import { FakeIdentity, FakeService, fakeListener, tokensFor } from './connect-fakes.ts';
import { COMPUTER_NAME_KEY, CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { memoryVault } from './vault.ts';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

/** A desk whose host name is `host`; `signedIn` false keeps it off the service altogether. */
async function newDesk(service: FakeService, host: string, opts: { signedIn?: boolean; enabled?: boolean; given?: string } = {}) {
  const settings = memorySettings();
  await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: opts.enabled ?? true }));
  if (opts.given) await settings.putSetting(COMPUTER_NAME_KEY, JSON.stringify({ name: opts.given, unsent: true }));
  const vault = memoryVault({ tokens: opts.signedIn === false ? null : tokensFor(0, Date.now()), device: null });
  const desk = new KestrelConnect({ vault, identity: new FakeIdentity(), service, settings, computerName: host, listen: fakeListener().listen });
  cleanup.push(() => desk.close());
  await desk.start();
  return { desk, settings, vault };
}

/** Welcomes every socket not welcomed yet, and waits for `desk` to be connected. */
async function connected(service: FakeService, desk: KestrelConnect, welcomed: Set<unknown>) {
  await until(() => service.sockets.some((s) => !welcomed.has(s)), 'the desk dials');
  for (const socket of service.sockets) {
    if (welcomed.has(socket)) continue;
    welcomed.add(socket);
    service.welcome(socket, Date.now() + 3_600_000);
  }
  await until(() => desk.view().link.state === 'connected', 'the desk connects');
}

/** Two desks of one account, both connected, each listing both. */
async function twoDesks() {
  const service = new FakeService();
  const welcomed = new Set<unknown>();
  const a = await newDesk(service, 'Laptop-A1B2C3');
  await connected(service, a.desk, welcomed);
  const b = await newDesk(service, 'Mac-mini');
  await connected(service, b.desk, welcomed);
  await until(() => a.desk.view().devices.length === 2 && b.desk.view().devices.length === 2, 'both desks list both');
  const idOf = (d: KestrelConnect) => d.device()!.id;
  const nameIn = (seen: KestrelConnect, of: KestrelConnect) => seen.view().devices.find((d) => d.id === idOf(of))?.name;
  return { service, welcomed, a, b, idOf, nameIn };
}

const stored = async (settings: ReturnType<typeof memorySettings>) => JSON.parse((await settings.getSetting(COMPUTER_NAME_KEY)) ?? 'null');

describe("this computer's name", () => {
  it('can be given with nobody signed in: kept here, used here, and cleared back to the host name', async () => {
    const service = new FakeService();
    const { desk, settings } = await newDesk(service, 'Laptop-A1B2C3', { signedIn: false, enabled: false });
    expect(desk.view()).toMatchObject({ computerName: 'Laptop-A1B2C3', hostName: 'Laptop-A1B2C3', givenName: null, nameProblem: null });
    const view = await desk.setComputerName('  Work   Laptop ');
    expect(view).toMatchObject({ computerName: 'Work Laptop', givenName: 'Work Laptop', nameProblem: null });
    expect(await stored(settings)).toEqual({ name: 'Work Laptop', unsent: true });
    expect(service.seen).toEqual([]);
    expect((await desk.setComputerName('')).computerName).toBe('Laptop-A1B2C3');
    expect(desk.view().givenName).toBeNull();
  });

  it('refuses a name that cannot be one, in words, and keeps the one it had', async () => {
    const { desk } = await newDesk(new FakeService(), 'Desk', { signedIn: false });
    await desk.setComputerName('Work Laptop');
    await expect(desk.setComputerName('x'.repeat(65))).rejects.toThrow('A device name is at most 64 characters.');
    await expect(desk.setComputerName('Work\u0007')).rejects.toThrow('control characters');
    expect(desk.view().computerName).toBe('Work Laptop');
  });

  it('is the name the computer registers under, and then needs no sending', async () => {
    const service = new FakeService();
    const { desk, settings } = await newDesk(service, 'Laptop-A1B2C3', { given: 'Work Laptop' });
    await connected(service, desk, new Set());
    expect(service.registered).toEqual([{ id: 'device-1', name: 'Work Laptop' }]);
    await until(async () => (await stored(settings)).unsent === false, 'the name is marked sent');
    expect(service.held.calls).not.toContain('PATCH /devices/device-1');
  });

  it('renamed while connected reaches the service at once, and the other desk is told and lists it', async () => {
    const { service, a, b, idOf, nameIn } = await twoDesks();
    await a.desk.setComputerName('Work Laptop');
    expect(service.held.devices.get(idOf(a.desk))?.name).toBe('Work Laptop');
    expect(await stored(a.settings)).toEqual({ name: 'Work Laptop', unsent: false });
    await until(() => nameIn(a.desk, a.desk) === 'Work Laptop', 'its own list shows it');
    await until(() => nameIn(b.desk, a.desk) === 'Work Laptop', 'the other desk, told devices-changed, shows it');
  });

  it('is kept and used here when the service does not take renames yet, says why, and is sent when Connect reconnects', async () => {
    const { service, welcomed, a, b, idOf, nameIn } = await twoDesks();
    service.held.renames = false;
    const view = await a.desk.setComputerName('Work Laptop');
    expect(view.computerName).toBe('Work Laptop');
    expect(view.nameProblem).toMatch(/^Kestrel Connect could not take the new name yet: Cannot PATCH .* It is used here, and sent again when Connect reconnects\.$/);
    expect(await stored(a.settings)).toEqual({ name: 'Work Laptop', unsent: true });
    expect(nameIn(b.desk, a.desk)).toBe('Laptop-A1B2C3');

    service.held.renames = true;
    const socket = service.sockets.find((s) => s.deviceId === idOf(a.desk) && s.closedWith === null)!;
    socket.closedWith = 1006;
    socket.events.closed(1006, 'gone');
    await connected(service, a.desk, welcomed);
    await until(() => service.held.devices.get(idOf(a.desk))?.name === 'Work Laptop', 'the name is sent on reconnect');
    await until(() => a.desk.view().nameProblem === null && nameIn(b.desk, a.desk) === 'Work Laptop', 'the other desk shows it');
  });

  it('renamed from another device is taken as its own, unless a name typed here still waits', async () => {
    const { service, a, b, idOf } = await twoDesks();
    await b.desk.renameDevice(idOf(a.desk), 'Work Laptop');
    await until(() => a.desk.view().computerName === 'Work Laptop', 'the renamed desk takes the name');
    expect(await stored(a.settings)).toEqual({ name: 'Work Laptop', unsent: false });

    // A name typed here that the service has not taken wins over one given elsewhere.
    service.held.renames = false;
    await a.desk.setComputerName('My Laptop');
    service.held.renames = true;
    await b.desk.renameDevice(idOf(a.desk), 'Office');
    await until(() => a.desk.view().devices.find((d) => d.here)?.name === 'Office', 'its list read again');
    expect(a.desk.view().computerName).toBe('My Laptop');
  });

  it('renamed elsewhere back to the host name is no given name at all', async () => {
    const { a, b, idOf } = await twoDesks();
    await a.desk.setComputerName('Work Laptop');
    await b.desk.renameDevice(idOf(a.desk), 'Laptop-A1B2C3');
    await until(() => a.desk.view().computerName === 'Laptop-A1B2C3', 'the name is taken');
    expect(a.desk.view().givenName).toBeNull();
  });
});

describe('renaming another device of the account', () => {
  it('renames it at the service; its own row is the name field', async () => {
    const { service, a, b, idOf, nameIn } = await twoDesks();
    const view = await a.desk.renameDevice(idOf(b.desk), ' Closet  Mac ');
    expect(view.devices.find((d) => d.id === idOf(b.desk))?.name).toBe('Closet Mac');
    expect(service.held.devices.get(idOf(b.desk))?.name).toBe('Closet Mac');
    await until(() => b.desk.view().computerName === 'Closet Mac', 'the renamed desk takes it');
    // Its own row goes through the name field.
    await a.desk.renameDevice(idOf(a.desk), 'Work Laptop');
    expect(a.desk.view().givenName).toBe('Work Laptop');
    await until(() => nameIn(b.desk, a.desk) === 'Work Laptop', 'told to the other desk');
  });

  it('refuses an empty name, a device not on the account, a service refusal, and while not connected', async () => {
    const { service, a, b, idOf } = await twoDesks();
    await expect(a.desk.renameDevice(idOf(b.desk), '  ')).rejects.toThrow('A device needs a name.');
    await expect(a.desk.renameDevice('device-99', 'Spare')).rejects.toThrow('That device is not on your account.');
    service.held.renames = false;
    await expect(a.desk.renameDevice(idOf(b.desk), 'Spare')).rejects.toThrow(/^Kestrel Connect could not rename it: Cannot PATCH/);
    expect(service.held.devices.get(idOf(b.desk))?.name).toBe('Mac-mini');
    await a.desk.setEnabled(false);
    await expect(a.desk.renameDevice(idOf(b.desk), 'Spare')).rejects.toThrow('Connect this computer to rename the devices of your account.');
  });

  it('is reached through the routes: PATCH /api/connect/name and PATCH /api/connect/devices/:id', async () => {
    const { a, b, idOf } = await twoDesks();
    const route = (parts: string[], body: Record<string, unknown>) => connectRoute(['api', 'connect', ...parts], 'PATCH', async () => body, a.desk);
    expect(await route(['name'], { name: 'Work Laptop' })).toMatchObject({ status: 200, body: { computerName: 'Work Laptop' } });
    expect(await route(['name'], { name: 7 })).toMatchObject({ status: 400 });
    expect(await route(['devices', idOf(b.desk)], { name: 'Closet Mac' })).toMatchObject({ status: 200 });
    expect(await route(['devices', idOf(b.desk)], { name: '' })).toEqual({ status: 409, body: { error: 'A device needs a name.' } });
  });
});
