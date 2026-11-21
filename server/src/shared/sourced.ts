// A value that comes from a source that may not have answered yet, or cannot answer. Every value
// the Details pane shows (git status, pull requests, usage) is one of these, so missing data never
// reads as a clean repository or passing checks: it is loading, unavailable with a reason, or ready.

export type Sourced<T> = { state: 'loading' } | { state: 'unavailable'; reason: string } | { state: 'ready'; value: T };

export const LOADING: Sourced<never> = { state: 'loading' };
export const ready = <T>(value: T): Sourced<T> => ({ state: 'ready', value });
export const unavailable = (reason: string): Sourced<never> => ({ state: 'unavailable', reason });

/** The longest reason kept: one short line. */
export const REASON_MAX = 200;

/**
 * A Sourced answer from the server, checked: anything that is not one (an older server that sends
 * something else, a missing field) becomes unavailable with `fallback` as the reason. The value
 * itself is checked by `isValue`.
 */
export function asSourced<T>(raw: unknown, isValue: (value: unknown) => value is T, fallback: string): Sourced<T> {
  if (typeof raw !== 'object' || raw === null) return unavailable(fallback);
  const r = raw as { state?: unknown; reason?: unknown; value?: unknown };
  if (r.state === 'loading') return LOADING;
  if (r.state === 'unavailable') return unavailable(typeof r.reason === 'string' && r.reason ? r.reason.slice(0, REASON_MAX) : fallback);
  if (r.state === 'ready' && isValue(r.value)) return ready(r.value);
  return unavailable(fallback);
}

/** The reason an error gives, as one short line. */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? 'Unknown error';
  return line.slice(0, REASON_MAX);
}
