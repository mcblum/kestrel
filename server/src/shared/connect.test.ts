import { describe, expect, it } from 'vitest';
import { DEVICE_NAME_MAX, deviceNameOf, keptOffWith } from './connect.ts';

describe('keptOffWith', () => {
  it('adds a project once and removes it, leaving the others as they were', () => {
    expect(keptOffWith([], 'p1', true)).toEqual(['p1']);
    expect(keptOffWith(['p1'], 'p1', true)).toEqual(['p1']);
    expect(keptOffWith(['p1', 'p2'], 'p1', false)).toEqual(['p2']);
    expect(keptOffWith(['p2'], 'p1', false)).toEqual(['p2']);
  });
});

describe('deviceNameOf', () => {
  it('trims a name and makes runs of white space one space', () => {
    expect(deviceNameOf('  Work   Laptop ')).toBe('Work Laptop');
    expect(deviceNameOf('Work\tLaptop\n')).toBe('Work Laptop');
  });

  it('gives null for a name left empty, which means the host name', () => {
    expect(deviceNameOf('')).toBeNull();
    expect(deviceNameOf('   ')).toBeNull();
  });

  it('refuses control characters and a name over the limit, in words', () => {
    expect(() => deviceNameOf('Work\u0007Laptop')).toThrow('A device name cannot hold control characters.');
    expect(deviceNameOf('é'.repeat(DEVICE_NAME_MAX))).toHaveLength(DEVICE_NAME_MAX);
    expect(() => deviceNameOf('x'.repeat(DEVICE_NAME_MAX + 1))).toThrow(`at most ${DEVICE_NAME_MAX} characters`);
  });
});
