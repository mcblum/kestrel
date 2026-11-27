import { describe, expect, test } from 'vitest';
import { archOfMachine, bundleFileName, checksumFileName, checksumFor, checksumLine, checksumProblem, elfArchOf, isNodeBundleArch, platformOfSystem } from './node-bundle.ts';

const HASH = 'a'.repeat(64);

describe('architecture and platform', () => {
  test('uname -m names map to the two bundles', () => {
    for (const machine of ['x86_64', 'amd64', ' x86_64\n']) expect(archOfMachine(machine)).toEqual({ ok: true, value: 'x64' });
    for (const machine of ['aarch64', 'arm64']) expect(archOfMachine(machine)).toEqual({ ok: true, value: 'arm64' });
  });

  test('any other processor is refused, naming it and what there is', () => {
    expect(archOfMachine('armv7l')).toEqual({ ok: false, reason: 'There is no Kestrel worker node for this processor (armv7l). It is built for x86_64 and aarch64 (arm64).' });
    expect(archOfMachine('')).toMatchObject({ ok: false, reason: expect.stringContaining('(unknown)') });
  });

  test('only Linux has a worker node; a Mac or Windows is pointed at the app', () => {
    expect(platformOfSystem('Linux\n')).toEqual({ ok: true, value: 'linux' });
    expect(platformOfSystem('Darwin')).toMatchObject({ ok: false, reason: expect.stringContaining('this is Darwin. On a Mac or Windows, install the Kestrel app.') });
  });

  test('is an architecture, and nothing else is', () => {
    expect(isNodeBundleArch('arm64')).toBe(true);
    expect(isNodeBundleArch('ia32')).toBe(false);
    expect(isNodeBundleArch(undefined)).toBe(false);
  });

  test('the files have the same names in every release', () => {
    expect(bundleFileName('x64')).toBe('kestrel-node-linux-x64.tar.gz');
    expect(checksumFileName('arm64')).toBe('kestrel-node-linux-arm64.tar.gz.sha256');
  });
});

describe('checksums', () => {
  test('a line is written as sha256sum writes it', () => {
    expect(checksumLine(HASH, 'kestrel-node-linux-x64.tar.gz')).toBe(`${HASH}  kestrel-node-linux-x64.tar.gz\n`);
    expect(() => checksumLine('not-a-hash', 'f')).toThrow(/Not a SHA-256/);
  });

  test('reads the line for the file from sha256sum output or SHASUMS256.txt, in either mode', () => {
    const shasums = `${'b'.repeat(64)}  node-v24.22.3-linux-arm64.tar.gz\n${HASH.toUpperCase()} *node-v24.22.3-linux-x64.tar.gz\n`;
    expect(checksumFor(shasums, 'node-v24.22.3-linux-x64.tar.gz')).toEqual({ ok: true, value: HASH });
    expect(checksumFor(shasums, 'node-v24.22.3-linux-arm64.tar.gz')).toEqual({ ok: true, value: 'b'.repeat(64) });
  });

  test('a file with no line for it is refused, not taken as a match', () => {
    expect(checksumFor(`${HASH}  other.tar.gz\n`, 'node.tar.gz')).toEqual({ ok: false, reason: 'The checksum file has no line for node.tar.gz.' });
    expect(checksumFor('', 'node.tar.gz')).toMatchObject({ ok: false });
  });

  test('a mismatch is refused, saying which file; a match is no problem', () => {
    expect(checksumProblem(HASH, HASH.toUpperCase(), 'f')).toBeNull();
    expect(checksumProblem(HASH, 'c'.repeat(64), 'kestrel-node-linux-x64.tar.gz')).toBe('The checksum of kestrel-node-linux-x64.tar.gz does not match (expected aaaaaaaaaaaa…, got cccccccccccc…). It was not used.');
  });
});

describe('elfArchOf', () => {
  const header = (machine: number, klass = 2, data = 1) => Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, klass, data, 1, 0, ...Array(10).fill(0), machine & 0xff, machine >> 8]);

  test('reads the processor a Linux module was built for', () => {
    expect(elfArchOf(header(0x3e))).toBe('x64');
    expect(elfArchOf(header(0xb7))).toBe('arm64');
  });

  test('anything else is null: another processor, 32-bit, big-endian, a Mach-O file, too short', () => {
    expect(elfArchOf(header(0x28))).toBeNull();
    expect(elfArchOf(header(0x3e, 1))).toBeNull();
    expect(elfArchOf(header(0x3e, 2, 2))).toBeNull();
    expect(elfArchOf(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, ...Array(16).fill(0)]))).toBeNull();
    expect(elfArchOf(Uint8Array.from([0x7f, 0x45]))).toBeNull();
  });
});
