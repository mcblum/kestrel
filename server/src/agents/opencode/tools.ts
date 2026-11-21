// OpenCode's tool calls in Kestrel's (Claude's) tool vocabulary, so the conversation, the Commands
// pane and the approval cards show them the same way: `bash` is `Bash`, `write` is `Write`,
// `kestrel_handoff` is `mcp__kestrel__handoff`, and so on. Inputs are renamed too (OpenCode's
// `filePath` is Claude's `file_path`). Tool names and inputs are those of opencode 1.14.25. Pure.
import { resolve } from 'node:path';
import { clip, describeApproval, summarizeTool, type ElementLookup } from '../claude/describe.ts';
import { KESTREL_SERVER } from './config.ts';

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MAX_LINE = 140;

export interface KestrelCall {
  /** The tool's name in Kestrel's vocabulary. */
  name: string;
  /** Its input in Kestrel's vocabulary. */
  input: Obj;
}

const RENAMED: Readonly<Record<string, string>> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  codesearch: 'WebSearch',
  task: 'Agent',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  skill: 'Skill',
  question: 'AskUserQuestion',
};

const KESTREL_PREFIX = `${KESTREL_SERVER}_`;

/** The files an apply_patch text adds, updates, deletes or moves to. */
export function patchFiles(patch: string): string[] {
  const found = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2] ?? '').trim());
  return [...new Set(found.filter(Boolean))];
}

/** An OpenCode tool call as Kestrel names it. */
export function kestrelCall(tool: string, input: Obj): KestrelCall {
  if (tool.startsWith(KESTREL_PREFIX)) return { name: `mcp__${KESTREL_SERVER}__${tool.slice(KESTREL_PREFIX.length)}`, input };
  const name = RENAMED[tool] ?? tool;
  const filePath = str(input.filePath);
  if (name === 'Write') return { name, input: { file_path: filePath, content: str(input.content) } };
  if (tool === 'edit') return { name, input: { file_path: filePath, old_string: str(input.oldString), new_string: str(input.newString) } };
  if (tool === 'read') return { name, input: { file_path: filePath } };
  return { name, input };
}

/** The files a call edits, absolute, resolved against `cwd`; none for a call that edits nothing. */
export function editedPaths(tool: string, input: Obj, cwd: string): string[] {
  if (tool === 'write' || tool === 'edit') return str(input.filePath) ? [resolve(cwd, str(input.filePath))] : [];
  if (tool === 'apply_patch') return patchFiles(str(input.patchText)).map((p) => resolve(cwd, p));
  return [];
}

/** One line for the conversation's activity row. */
export function summarize(tool: string, input: Obj, cwd: string, element?: ElementLookup): string {
  const call = kestrelCall(tool, input);
  switch (tool) {
    case 'apply_patch': {
      const files = patchFiles(str(input.patchText));
      return files.length === 1 ? summarizeTool('Edit', { file_path: resolve(cwd, files[0]!) }, cwd) : `Edit ${files.length} files`;
    }
    case 'list':
      return `List ${str(input.path) || 'the folder'}`;
    case 'webfetch':
      return clip(`Fetch ${str(input.url) || 'a page'}`, MAX_LINE);
    case 'websearch':
    case 'codesearch':
      return clip(`Search the web for ${str(input.query)}`, MAX_LINE);
    case 'todowrite':
      return 'Update the task list';
    case 'skill':
      return clip(`Use the skill ${str(input.name)}`, MAX_LINE);
    case 'question':
      return 'Ask you a question';
    default:
      return summarizeTool(call.name, call.input, cwd, element);
  }
}

/** A card's title and what exactly would run or be written, for a call OpenCode asks about. */
export function describeCall(tool: string, input: Obj, cwd: string, element?: ElementLookup): { title: string; detail: string } {
  if (tool === 'apply_patch') return { title: summarize(tool, input, cwd), detail: clip(str(input.patchText), 4000) };
  const call = kestrelCall(tool, input);
  return describeApproval(call.name, call.input, cwd, element);
}
