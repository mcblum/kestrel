// What OpenCode gets for a user message, and what "/" offers. Pure.
//
// - Pictures go as file parts with a file:// URL, which OpenCode reads from where Kestrel stored
//   them (the session may read its attachments folder) and hands to models that take images;
//   every other file goes in the attachment note and the agent reads it with its own tools.
// - Slash commands are OpenCode's `command.list` (its own commands, the user's, MCP prompts and
//   skills). A message that starts with "/name" of a listed command runs as that command
//   (`session.command`, the rest of the message as its arguments), as OpenCode's own UI does.
import { pathToFileURL } from 'node:url';
import { attachmentNote } from '../attachment-note.ts';
import type { AgentAttachment } from '../types.ts';
import { slashCommandsFrom, type SlashCommand } from '../../shared/slash-commands.ts';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Said when the user sent files and no words, so the turn has text to answer. */
export const FILES_ONLY_TEXT = 'The user sent the attached files without a message.';

export type PromptPart = { type: 'text'; text: string } | { type: 'file'; mime: string; filename: string; url: string };

export function promptParts(text: string, files: readonly AgentAttachment[] = []): PromptPart[] {
  const pictures = files.filter((f) => f.kind === 'image' && IMAGE_TYPES.has(f.mediaType));
  const noted = files.filter((f) => !pictures.includes(f));
  const words = [text, attachmentNote(noted)].filter(Boolean).join('\n\n') || FILES_ONLY_TEXT;
  return [{ type: 'text', text: words }, ...pictures.map((f) => ({ type: 'file' as const, mime: f.mediaType, filename: f.name, url: pathToFileURL(f.file).href }))];
}

/** OpenCode's `command.list` answer as the menu's commands. */
export function slashCommands(listed: unknown): SlashCommand[] {
  const entries = (Array.isArray(listed) ? listed : []).map((c) => {
    const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
    const hints = Array.isArray(o.hints) ? o.hints.filter((h): h is string => typeof h === 'string') : [];
    return { name: o.name, description: o.description, argumentHint: hints.join(' ') };
  });
  return slashCommandsFrom(entries);
}

/** The listed command a message runs ("/name" or "/name arguments"); null when it names none. */
export function commandCalled(text: string, commands: readonly SlashCommand[]): { command: string; arguments: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  const found = match ? commands.find((c) => c.name === match[1]) : undefined;
  return found ? { command: found.name, arguments: (match![2] ?? '').trim() } : null;
}
