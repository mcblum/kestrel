import { describe, expect, test } from 'vitest';
import { BUNDLE_INSTALLER, channelOfVersion, installerOf, OLD_BUNDLE_INSTALLER, upgradePlan } from './upgrade.ts';

describe('kestrel upgrade', () => {
  test('a beta follows the betas, a release the releases', () => {
    expect(channelOfVersion('0.0.34-beta.1')).toBe('beta');
    expect(channelOfVersion('0.0.34')).toBe('stable');
  });

  test('runs the bundle’s own install script on the installed version’s channel, with the version asked for', () => {
    const current = '/home/u/.kestrel/node/current';
    expect(upgradePlan({ version: '0.0.35-beta.2', installer: BUNDLE_INSTALLER, current }, undefined)).toEqual({ ok: true, script: `${current}/share/install.sh`, args: [], channel: 'beta' });
    expect(upgradePlan({ version: '0.0.35', installer: BUNDLE_INSTALLER, current }, '0.0.36')).toEqual({ ok: true, script: `${current}/share/install.sh`, args: ['0.0.36'], channel: 'stable' });
  });

  test('a bundle from before the rename carries the script by its old name, which is run when the new one is missing', () => {
    expect(installerOf((path) => path === BUNDLE_INSTALLER || path === OLD_BUNDLE_INSTALLER)).toBe('share/install.sh');
    expect(installerOf((path) => path === OLD_BUNDLE_INSTALLER)).toBe('share/install-node.sh');
    expect(installerOf(() => false)).toBeNull();
    const current = '/home/u/.kestrel/node/current';
    expect(upgradePlan({ version: '0.0.34-beta.1', installer: OLD_BUNDLE_INSTALLER, current }, '0.0.34-beta.2')).toEqual({ ok: true, script: `${current}/share/install-node.sh`, args: ['0.0.34-beta.2'], channel: 'beta' });
  });

  test('refuses with the reason where there is nothing to upgrade or no script to do it with', () => {
    expect(upgradePlan({ version: null, installer: null, current: '/x' }, undefined)).toMatchObject({ ok: false, reason: expect.stringContaining('no installed node') });
    expect(upgradePlan({ version: '0.0.34-beta.1', installer: null, current: '/x' }, undefined)).toMatchObject({ ok: false, reason: expect.stringContaining('Run the install command again') });
  });
});
