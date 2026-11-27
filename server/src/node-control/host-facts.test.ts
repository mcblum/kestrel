import { describe, expect, test } from 'vitest';
import { hostFacts, serviceState, type HostProbe } from './host-facts.ts';

/** A Linux box from anywhere: the files it has, and what systemctl answers. */
function probe(change: Partial<HostProbe> & { files?: string[]; shown?: string | null } = {}): HostProbe & { asked: string[][] } {
  const files = new Set(change.files ?? ['/run/systemd/system', '/home/k/.kestrel', '/home/k/.kestrel/node/current']);
  const asked: string[][] = [];
  return {
    platform: 'linux',
    home: '/home/k',
    dataDir: '/home/k/.kestrel',
    user: 'k',
    run: async (file, args) => (asked.push([file, ...args]), change.shown === undefined ? 'LoadState=loaded\nActiveState=active\nMainPID=77\n' : change.shown),
    exists: (path) => files.has(path),
    freeBytes: () => 123,
    read: (path) => (path === '/home/k/.kestrel/node/0.0.34/VERSION' ? '0.0.34\n' : null),
    realpath: (path) => (path === '/home/k/.kestrel/node/current' ? '/home/k/.kestrel/node/0.0.34' : path),
    asked,
    ...change,
  };
}

describe('hostFacts', () => {
  test('reads the unit, lingering, free disk and the installed bundle', async () => {
    const p = probe({ files: ['/run/systemd/system', '/var/lib/systemd/linger/k', '/home/k/.kestrel', '/home/k/.kestrel/node/current'] });
    expect(await hostFacts(p)).toEqual({
      user: 'k',
      lingering: 'on',
      service: { manager: 'systemd', installed: true, active: true, mainPid: 77 },
      disk: { path: '/home/k/.kestrel', freeBytes: 123 },
      bundle: { version: '0.0.34', path: '/home/k/.kestrel/node/0.0.34' },
    });
    expect(p.asked).toEqual([['systemctl', '--user', 'show', 'kestrel-node.service', '--property=LoadState,ActiveState,MainPID']]);
  });

  test('no linger file is off; no systemd at all is unknown, with no service', async () => {
    expect((await hostFacts(probe())).lingering).toBe('off');
    const bare = await hostFacts(probe({ files: ['/home/k/.kestrel'], shown: null }));
    expect(bare).toMatchObject({ lingering: 'unknown', service: { manager: 'none' }, bundle: null });
  });

  test('a checkout has no bundle; a data folder not made yet measures the home folder', async () => {
    const facts = await hostFacts(probe({ files: ['/run/systemd/system'] }));
    expect(facts.bundle).toBeNull();
    expect(facts.disk).toEqual({ path: '/home/k', freeBytes: 123 });
  });

  test('a disk that cannot be measured is said to be so, not thrown', async () => {
    const facts = await hostFacts(probe({ freeBytes: () => { throw new Error('EACCES'); } }));
    expect(facts.disk).toBeNull();
  });

  test('a Mac or Windows asks systemctl nothing', async () => {
    const p = probe({ platform: 'mac' });
    expect(await serviceState(p)).toEqual({ manager: 'none' });
    expect((await hostFacts(p)).lingering).toBe('unknown');
    expect(p.asked).toEqual([]);
  });
});
