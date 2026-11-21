// The note that tells an agent about attached files it should read itself. Shared by every
// adapter: Claude uses it for files that are not pictures or PDFs; an agent that cannot take
// pictures at all gets every file this way. Pure.
import { formatSize } from '../shared/attachments.ts';
import type { AgentAttachment } from './types.ts';

const OPEN = '<kestrel-attachments>';
const CLOSE = '</kestrel-attachments>';

/** One line per file: where it is stored, its name, size and type. Empty for no files. */
export function attachmentNote(files: readonly AgentAttachment[], why = 'The user attached these files. Read them from these paths with your file tools; they are read-only copies.'): string {
  if (files.length === 0) return '';
  const lines = files.map((f) => `- ${f.file} (${f.name}, ${formatSize(f.size)}, ${f.mediaType})`);
  return [OPEN, why, ...lines, CLOSE].join('\n');
}

/** The message text with the note after it; the text alone when there are no files. */
export function withAttachmentNote(text: string, files: readonly AgentAttachment[]): string {
  const note = attachmentNote(files);
  if (!note) return text;
  return text ? `${text}\n\n${note}` : note;
}
