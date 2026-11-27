import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { agentPins } from '../node-control/agent-pins.ts';
import { agentPinsOf, agentPinsText, CODEX_TESTED_VERSION, compareVersions, downgradeNote, parseAgentPins, pinMoveOf, pinNote } from './node-agent-versions.ts';

const serverPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };

describe('the versions a node installs', () => {
  test('OpenCode at the server’s own SDK version, Codex at the version it was tried with; never latest', () => {
    const pins = agentPinsOf(serverPackage);
    expect(pins).toEqual({ codex: CODEX_TESTED_VERSION, opencode: serverPackage.dependencies['@opencode-ai/sdk'] });
    expect(Object.values(pins)).not.toContain('latest');
  });

  test('a range for the SDK is refused: the bundle and the node must agree on one version', () => {
    expect(() => agentPinsOf({ dependencies: { '@opencode-ai/sdk': '^1.14.25' } })).toThrow(/one exact version/);
    expect(() => agentPinsOf({})).toThrow(/missing/);
  });

  test('the bundle carries them, and the node reads them back; anything else is no pins', () => {
    const pins = { codex: '0.172.0', opencode: '1.14.25' };
    expect(parseAgentPins(agentPinsText(pins))).toEqual(pins);
    expect(parseAgentPins('{"codex":"latest","opencode":"1.14.25"}')).toBeNull();
    expect(parseAgentPins(null)).toBeNull();
  });

  test('an installed node reads its bundle’s; a checkout works them out as the build does', () => {
    const bundled = agentPins('/home/me', (path) => (path === '/home/me/.kestrel/node/current/agents.json' ? '{"codex":"0.180.0","opencode":"1.15.0"}' : null));
    expect(bundled).toEqual({ codex: '0.180.0', opencode: '1.15.0' });
    expect(agentPins('/home/me', () => null, () => JSON.stringify(serverPackage))).toEqual(agentPinsOf(serverPackage));
    expect(() => agentPins('/home/me', () => null, () => null)).toThrow(/Install the node again/);
  });
});

describe('moving an installed agent to its pin', () => {
  test('the pinned version stays; any other, or one that could not be read, is offered the pin', () => {
    expect(pinMoveOf('0.172.0', '0.172.0')).toEqual({ move: false });
    expect(pinMoveOf('0.180.0', '0.172.0')).toEqual({ move: true, from: '0.180.0', to: '0.172.0', down: true });
    expect(pinMoveOf(null, '0.172.0')).toEqual({ move: true, from: null, to: '0.172.0', down: false })
    expect(pinMoveOf('1.14.2', '1.14.25')).toMatchObject({ down: false });
    expect(pinMoveOf('1.19.6', '1.14.25')).toMatchObject({ down: true });
    expect(compareVersions('1.14.25', '1.19.6')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(downgradeNote('OpenCode', '1.19.6', '1.14.25')).toBe("1.14.25 is older than the 1.19.6 installed: OpenCode's own data, written by 1.19.6, may not open in 1.14.25.");
  });

  test('why this version, said only when the newest differs', () => {
    expect(pinNote('opencode', '1.14.25', '1.19.6')).toBe('It installs 1.14.25, the version of the OpenCode SDK this Kestrel is built with; the newest is 1.19.6. Upgrading the node (kestrel upgrade) brings newer pins.');
    expect(pinNote('codex', '0.172.0', '0.172.0')).toBeNull();
    expect(pinNote('codex', '0.172.0', null)).toBeNull();
  });
});
