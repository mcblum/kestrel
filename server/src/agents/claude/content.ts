// What Claude gets for a user message with files attached (docs/designs/kestrel.md, "Attachments"):
// - pictures (png, jpeg, gif, webp) as image blocks, base64, before the text; one over the API's
//   size limit is made smaller first (`downscale`), and if that cannot be done it goes as a file;
// - PDFs up to CLAUDE_PDF_MAX_BYTES as document blocks;
// - anything else as a note listing where each file is stored, read with Claude's own tools.
// A message without files is the plain string it always was.
import { readFile } from 'node:fs/promises';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { attachmentNote } from '../attachment-note.ts';
import type { AgentAttachment } from '../types.ts';
import { downscaleWithSips, type Downscale } from './downscale.ts';

/** The API refuses a picture over 5 MB once base64-encoded; base64 is 4/3 the size. */
export const CLAUDE_IMAGE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** PDFs at most this size go as documents; larger ones are read as files. */
export const CLAUDE_PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Said when the user sent files and no words, so the turn has text to answer. */
export const FILES_ONLY_TEXT = 'The user sent the attached files without a message.';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ContentDeps {
  read: (file: string) => Promise<Buffer>;
  downscale: Downscale;
}
const DEFAULT_DEPS: ContentDeps = { read: (file) => readFile(file), downscale: downscaleWithSips };

/** A picture block for the file, made smaller if it must be; null when it cannot be sent as a picture. */
async function imageBlock(file: AgentAttachment, deps: ContentDeps): Promise<ContentBlockParam | null> {
  if (!IMAGE_TYPES.has(file.mediaType)) return null;
  const small = file.size <= CLAUDE_IMAGE_MAX_BYTES ? { mediaType: file.mediaType, data: await deps.read(file.file) } : await deps.downscale(file.file, CLAUDE_IMAGE_MAX_BYTES);
  if (!small || small.data.length > CLAUDE_IMAGE_MAX_BYTES || !IMAGE_TYPES.has(small.mediaType)) return null;
  return { type: 'image', source: { type: 'base64', media_type: small.mediaType as ImageType, data: small.data.toString('base64') } };
}

async function pdfBlock(file: AgentAttachment, deps: ContentDeps): Promise<ContentBlockParam | null> {
  if (file.mediaType !== 'application/pdf' || file.size > CLAUDE_PDF_MAX_BYTES) return null;
  return { type: 'document', title: file.name, source: { type: 'base64', media_type: 'application/pdf', data: (await deps.read(file.file)).toString('base64') } };
}

/** One file as a content block, or null when it goes in the note instead. Unreadable files go in the note. */
async function blockFor(file: AgentAttachment, deps: ContentDeps): Promise<ContentBlockParam | null> {
  try {
    return file.kind === 'image' ? await imageBlock(file, deps) : await pdfBlock(file, deps);
  } catch {
    return null;
  }
}

/** The user message's content: the text unchanged when there are no files, else blocks. */
export async function userContent(text: string, files: readonly AgentAttachment[] | undefined, deps: ContentDeps = DEFAULT_DEPS): Promise<string | ContentBlockParam[]> {
  if (!files || files.length === 0) return text;
  const blocks = await Promise.all(files.map((f) => blockFor(f, deps)));
  const inline = blocks.filter((b): b is ContentBlockParam => b !== null);
  const noted = files.filter((_, i) => blocks[i] === null);
  const tooBig = noted.filter((f) => f.kind === 'image');
  const note = attachmentNote(noted, tooBig.length ? 'The user attached these files (pictures among them were too large to show you directly). Read them from these paths with your file tools; they are read-only copies.' : undefined);
  const words = [text, note].filter(Boolean).join('\n\n') || FILES_ONLY_TEXT;
  return [...inline, { type: 'text', text: words }];
}
