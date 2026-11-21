import { describe, expect, it } from 'vitest';
import { normalizeScopeKey, parseScope, scopeKey } from './scope.ts';

describe('scopes', () => {
  it('reads the three kinds', () => {
    expect(parseScope('session:abc')).toEqual({ kind: 'session', id: 'abc' });
    expect(parseScope('project:p1')).toEqual({ kind: 'project', id: 'p1' });
    expect(parseScope('group:g1')).toEqual({ kind: 'group', id: 'g1' });
  });

  it('reads a bare id as a session, so keys stored before scopes still work', () => {
    expect(parseScope('6f1c-uuid')).toEqual({ kind: 'session', id: '6f1c-uuid' });
    expect(normalizeScopeKey('session:6f1c-uuid')).toBe('6f1c-uuid');
    expect(normalizeScopeKey('6f1c-uuid')).toBe('6f1c-uuid');
  });

  it('writes a session as its bare id and the others with their kind', () => {
    expect(scopeKey({ kind: 'session', id: 's1' })).toBe('s1');
    expect(scopeKey({ kind: 'project', id: 'p1' })).toBe('project:p1');
    expect(scopeKey({ kind: 'group', id: 'g1' })).toBe('group:g1');
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'planet:x', 'project:', 'project:a:b', 'a b', 42, null, 'x'.repeat(101)]) expect(parseScope(bad)).toBeNull();
  });
});
