// What Claude is sent for a message with files: a plain string without them (exactly as before),
// image and document blocks for pictures and PDFs, a note for anything else.
import { describe, expect, it } from 'vitest';
import type { AgentAttachment } from '../types.ts';
import { CLAUDE_IMAGE_MAX_BYTES, FILES_ONLY_TEXT, userContent, type ContentDeps } from './content.ts';

const bytes: Record<string, Buffer> = { '/a/shot.png': Buffer.from('png-bytes'), '/a/doc.pdf': Buffer.from('%PDF-1.4'), '/a/huge.png': Buffer.from('huge') };
const deps = (downscaled: { mediaType: string; data: Buffer } | null = null): ContentDeps => ({
  read: async (file) => bytes[file] ?? Buffer.from(''),
  downscale: async () => downscaled,
});
const image: AgentAttachment = { name: 'shot.png', mediaType: 'image/png', size: 9, kind: 'image', file: '/a/shot.png' };
const pdf: AgentAttachment = { name: 'doc.pdf', mediaType: 'application/pdf', size: 8, kind: 'file', file: '/a/doc.pdf' };
const notes: AgentAttachment = { name: 'notes.txt', mediaType: 'text/plain', size: 2048, kind: 'file', file: '/data/attachments/sessions/s/1/notes.txt' };
const huge: AgentAttachment = { name: 'huge.png', mediaType: 'image/png', size: CLAUDE_IMAGE_MAX_BYTES + 1, kind: 'image', file: '/a/huge.png' };

describe('the user message Claude gets', () => {
  it('is the same plain string as before when there are no files', async () => {
    expect(await userContent('just text', undefined, deps())).toBe('just text');
    expect(await userContent('just text', [], deps())).toBe('just text');
  });

  it('puts a picture first as a base64 image block, then the text', async () => {
    expect(await userContent('what is this?', [image], deps())).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('says the user sent only files when there is no text', async () => {
    const content = await userContent('', [image], deps());
    expect(Array.isArray(content) && content.at(-1)).toEqual({ type: 'text', text: FILES_ONLY_TEXT });
  });

  it('sends a PDF as a document block', async () => {
    const content = await userContent('summarise', [pdf], deps());
    expect(Array.isArray(content) && content[0]).toMatchObject({ type: 'document', title: 'doc.pdf', source: { type: 'base64', media_type: 'application/pdf' } });
  });

  it('lists any other file in a delimited note with its stored path, name and size', async () => {
    const content = await userContent('read this', [notes], deps());
    expect(content).toHaveLength(1);
    const text = (content as { type: 'text'; text: string }[])[0]!.text;
    expect(text.startsWith('read this\n\n<kestrel-attachments>')).toBe(true);
    expect(text).toContain('- /data/attachments/sessions/s/1/notes.txt (notes.txt, 2 KB, text/plain)');
    expect(text.endsWith('</kestrel-attachments>')).toBe(true);
  });

  it('sends a too-large picture made smaller when it can be', async () => {
    const content = await userContent('look', [huge], deps({ mediaType: 'image/jpeg', data: Buffer.from('small') }));
    expect(Array.isArray(content) && content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('small').toString('base64') } });
  });

  it('sends a too-large picture that cannot be made smaller as a file to read, and says why', async () => {
    const content = await userContent('look', [huge], deps(null));
    const text = (content as { type: 'text'; text: string }[])[0]!.text;
    expect(content).toHaveLength(1);
    expect(text).toContain('too large to show you directly');
    expect(text).toContain('/a/huge.png (huge.png');
  });
});
