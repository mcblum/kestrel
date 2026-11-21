import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, showEnvironmentControl } from './environments.ts';

describe('environment control', () => {
  it('is hidden while This Mac is the only environment', () => {
    expect(ENVIRONMENTS).toHaveLength(1);
    expect(showEnvironmentControl()).toBe(false);
  });
  it('appears once there is an alternative', () => {
    expect(showEnvironmentControl([...ENVIRONMENTS, { id: 'remote', label: 'Devbox' }])).toBe(true);
  });
});
