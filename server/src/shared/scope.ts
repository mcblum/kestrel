// What a side pane (terminal, files, browser, simulator) belongs to: a session, a project page or a
// group page. Pure. On the wire a scope is one string: `project:<id>`, `group:<id>`, or a session's
// bare id. `session:<id>` is accepted and means the same as the bare id, so keys stored before
// scopes existed (bare session ids) keep working and a session's key never changes.

export type ScopeKind = 'session' | 'project' | 'group';
export interface Scope {
  kind: ScopeKind;
  id: string;
}

const MAX_ID_CHARS = 100;
const validId = (id: string) => id.length > 0 && id.length <= MAX_ID_CHARS && !id.includes(':') && !/\s/.test(id);

/** A scope from its wire string, or null when the string is not one. */
export function parseScope(key: unknown): Scope | null {
  if (typeof key !== 'string') return null;
  const colon = key.indexOf(':');
  if (colon === -1) return validId(key) ? { kind: 'session', id: key } : null;
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if ((kind === 'session' || kind === 'project' || kind === 'group') && validId(id)) return { kind, id };
  return null;
}

/** The one string a scope is known by: a session's bare id, else `kind:id`. */
export const scopeKey = (scope: Scope): string => (scope.kind === 'session' ? scope.id : `${scope.kind}:${scope.id}`);

/** The canonical string for any accepted spelling (`session:x` becomes `x`), or null. */
export function normalizeScopeKey(key: unknown): string | null {
  const scope = parseScope(key);
  return scope ? scopeKey(scope) : null;
}
