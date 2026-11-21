import { describe, expect, it } from 'vitest';
import { dataDir } from './data-dir.ts';

describe('where Kestrel keeps its data', () => {
  it('a build run from source uses its own folder, never the installed app\'s', () => {
    expect(dataDir({}, '/Users/me')).toBe('/Users/me/.kestrel-dev');
  });
  it('the packaged app uses the real one', () => {
    expect(dataDir({ KESTREL_PACKAGED: '1' }, '/Users/me')).toBe('/Users/me/.kestrel');
  });
  it('an explicit folder wins over both', () => {
    expect(dataDir({ KESTREL_DATA_DIR: '/tmp/x' }, '/Users/me')).toBe('/tmp/x');
    expect(dataDir({ KESTREL_DATA_DIR: '/tmp/x', KESTREL_PACKAGED: '1' }, '/Users/me')).toBe('/tmp/x');
  });
});
