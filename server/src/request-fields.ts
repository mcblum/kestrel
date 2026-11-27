// Reading the fields of a request body, for the HTTP routes and for what another desktop asks of a session here
// (session-routes.ts): one set of checks, one error type. A `BadRequest` is answered 400 by http.ts, and its words go
// back to the other computer as the refusal (connect/dispatcher.ts).

/** A field that is missing or malformed: the words say which. */
export class BadRequest extends Error {}

/** A required, non-blank text field of at most `max` characters, trimmed. */
export function str(value: unknown, field: string, max = 400): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequest(`${field} is required`);
  if (value.length > max) throw new BadRequest(`${field} is too long`);
  return value.trim();
}

/** An id, or null when it is left out. */
export function optionalId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 100) throw new BadRequest(`${field} must be an id or null`);
  return value;
}

/** A path segment as sent (the UI encodes a scope key's `:`); one that does not decode stays as it is and matches nothing. */
export function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
