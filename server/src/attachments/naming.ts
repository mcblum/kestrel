// Checks on what an upload says about itself: a safe file name, a media type, and whether the
// bytes really are a picture. Pure. Used at the server boundary (api.ts) before anything is stored.

/** Longest stored file name, and longest original path kept. */
export const ATTACHMENT_NAME_MAX = 120;
export const ATTACHMENT_PATH_MAX = 4096;
const MEDIA_TYPE_MAX = 100;
const FALLBACK_NAME = 'attachment';

/** Picture types sent to a model as pictures, each with the bytes it starts with. */
const IMAGE_SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a') },
  { type: 'image/webp', test: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

/** Types guessed from the extension when the upload does not say, for serving and for the agent's note. */
const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  zip: 'application/zip',
};

/** The picture type the bytes are, or null when they are not one Kestrel sends as a picture. */
export function sniffImage(bytes: Buffer): string | null {
  return IMAGE_SIGNATURES.find((s) => s.test(bytes))?.type ?? null;
}

/**
 * A name safe to store and show: the last path segment only, no control characters, no
 * separators, no leading dots (so never `.` or `..` or a hidden file), at most ATTACHMENT_NAME_MAX
 * characters with the extension kept.
 */
export function sanitizeName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim();
  if (!cleaned) return FALLBACK_NAME;
  if (cleaned.length <= ATTACHMENT_NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, ATTACHMENT_NAME_MAX - ext.length) + ext;
}

/** The type to record: what the bytes are when they are a picture, else a well-formed declared type, else one from the extension. */
export function mediaTypeOf(name: string, declared: string | undefined, bytes: Buffer): string {
  const sniffed = sniffImage(bytes);
  if (sniffed) return sniffed;
  const given = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  // A declared picture type the bytes do not bear out is not believed.
  if (given && given.length <= MEDIA_TYPE_MAX && /^[\w.+-]+\/[\w.+-]+$/.test(given) && !given.startsWith('image/')) return given;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** The original path as given, if it is a plausible absolute path; anything else is dropped. */
export function originalPath(raw: string | undefined): string | undefined {
  if (!raw || raw.length > ATTACHMENT_PATH_MAX || !raw.startsWith('/')) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/.test(raw) ? undefined : raw;
}

/** Ids Kestrel makes (uuids) and draft ids the UI makes: letters, digits and dashes only. */
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9-]{1,64}$/.test(id);
