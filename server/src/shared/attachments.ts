// Files the user attaches to a message (docs/designs/kestrel.md, "Attachments"). The type and the
// small pure helpers both sides use; the server's storage is in attachments/, the UI's in
// ui/src/components/attachments/.

/**
 * A file the user attached to a message. Stored under the session's attachments folder by `id`;
 * `path` is where it came from on the user's disk, when the shell could say.
 */
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: 'image' | 'file';
  path?: string;
}

/** Largest single file, and largest total for one message. */
export const ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/** Most files on one message. */
export const ATTACHMENT_MAX_PER_MESSAGE = 20;

const UNITS = ['bytes', 'KB', 'MB', 'GB'] as const;

/** "512 bytes", "1.4 KB", "20 MB". */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return unit === 0 && shown === 1 ? '1 byte' : `${shown} ${UNITS[unit]}`;
}

/** A long file name shortened in the middle, keeping its extension: "a-very-lo…name.txt". */
export function middleEllipsis(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : '';
  const room = max - ext.length - 1;
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  const stem = name.slice(0, name.length - ext.length);
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(-tail) : ''}${ext}`;
}

/** What a message is about when it has no text: its files' names. */
export function attachmentsLabel(attachments: readonly Pick<Attachment, 'name'>[]): string {
  return attachments.map((a) => a.name).join(', ');
}

/** Why a set of files cannot go on one message, or null. */
export function messageLimitReason(attachments: readonly Pick<Attachment, 'size'>[]): string | null {
  if (attachments.length > ATTACHMENT_MAX_PER_MESSAGE) return `At most ${ATTACHMENT_MAX_PER_MESSAGE} files on one message.`;
  const total = attachments.reduce((sum, a) => sum + a.size, 0);
  if (total > ATTACHMENT_MAX_MESSAGE_BYTES) return `These files come to ${formatSize(total)}; one message takes at most ${formatSize(ATTACHMENT_MAX_MESSAGE_BYTES)}.`;
  return null;
}
