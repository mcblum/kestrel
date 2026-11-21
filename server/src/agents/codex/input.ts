// What Codex gets for a user message (`turn/start`'s `input`). Pictures go as `localImage` items,
// read by Codex from where Kestrel stored them (the session may read its attachments folder);
// every other file, PDFs included, goes in the attachment note and Codex reads it with its own
// tools. Pure.
import { attachmentNote } from '../attachment-note.ts';
import type { AgentAttachment } from '../types.ts';
import { skillCalled, skillMention, type CodexSkill } from './skills.ts';

/** The image types Codex's models take (`inputModalities: image`). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Said when the user sent files and no words, so the turn has text to answer. */
export const FILES_ONLY_TEXT = 'The user sent the attached files without a message.';

export type CodexInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string } | { type: 'skill'; name: string; path: string };

export const textInput = (text: string): CodexInput => ({ type: 'text', text, text_elements: [] });

/**
 * `skills`: what Codex lists for the session, when the message may call one. A message that
 * starts with "/name" of a listed skill goes as that skill, with the text naming it the way
 * Codex's own UI does (`skillMention`) and then the rest of the message.
 */
export function codexInput(text: string, files: readonly AgentAttachment[] = [], skills: readonly CodexSkill[] = []): CodexInput[] {
  const pictures = files.filter((f) => f.kind === 'image' && IMAGE_TYPES.has(f.mediaType));
  const noted = files.filter((f) => !pictures.includes(f));
  const called = skillCalled(text, skills);
  const said = called ? [skillMention(called.skill), called.rest].filter(Boolean).join(' ') : text;
  const words = [said, attachmentNote(noted)].filter(Boolean).join('\n\n') || FILES_ONLY_TEXT;
  return [...(called ? [{ type: 'skill' as const, name: called.skill.name, path: called.skill.path }] : []), textInput(words), ...pictures.map((f) => ({ type: 'localImage' as const, path: f.file }))];
}
