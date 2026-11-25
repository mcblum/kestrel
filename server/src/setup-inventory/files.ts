// The agents' own instruction, rules, skill and settings files, listed per agent. Each file's text is
// read only so the split can look for a key in it (O11); the record keeps names, counts and where a
// key was found, never the text. Credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`,
// OpenCode's `auth.json`) are not on these lists and are never opened.
import { join } from 'node:path';
import type { Agent } from '../model.ts';
import type { FoundFile, SetupFileKind } from '../shared/setup-record.ts';
import type { FsRead } from './io.ts';

/** How deep into a skill or rules folder, and how many files from one, are read. */
const MAX_DEPTH = 6;
const MAX_FILES = 400;
const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);

/** The files under a folder, as text; binary and oversized files are counted with no text. */
function walk(fs: FsRead, dir: string, depth = 0, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  if (depth > MAX_DEPTH) return out;
  for (const entry of fs.list(dir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_FILES) break;
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.dir) walk(fs, path, depth + 1, out);
    else {
      const text = fs.text(path);
      out.push({ path, text: text && !text.includes('\u0000') ? text : '' });
    }
  }
  return out;
}

function file(fs: FsRead, agent: Agent, kind: SetupFileKind, path: string): FoundFile[] {
  const text = fs.text(path);
  return text === null ? [] : [{ agent, kind, path, texts: [{ path, text }] }];
}

function folder(fs: FsRead, agent: Agent, kind: SetupFileKind, path: string): FoundFile[] {
  const texts = walk(fs, path);
  return texts.length === 0 ? [] : [{ agent, kind, path, texts }];
}

/** Every folder directly under `dir`, as one skill each. */
function skills(fs: FsRead, agent: Agent, dir: string): FoundFile[] {
  return fs
    .list(dir)
    .filter((e) => e.dir && !SKIP.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => folder(fs, agent, 'skill', join(dir, e.name)));
}

export function readAgentFiles(fs: FsRead, home: string): FoundFile[] {
  const claude = join(home, '.claude');
  const codex = join(home, '.codex');
  const opencode = join(home, '.config', 'opencode');
  return [
    ...file(fs, 'claude', 'instructions', join(claude, 'CLAUDE.md')),
    ...folder(fs, 'claude', 'rules', join(claude, 'rules')),
    ...file(fs, 'claude', 'settings', join(claude, 'settings.json')),
    ...file(fs, 'claude', 'settings', join(claude, 'settings.local.json')),
    ...skills(fs, 'claude', join(claude, 'skills')),
    ...file(fs, 'codex', 'instructions', join(codex, 'AGENTS.md')),
    ...file(fs, 'codex', 'settings', join(codex, 'config.toml')),
    ...skills(fs, 'codex', join(codex, 'skills')),
    ...file(fs, 'opencode', 'instructions', join(opencode, 'AGENTS.md')),
    ...file(fs, 'opencode', 'settings', join(opencode, 'opencode.json')),
    ...file(fs, 'opencode', 'settings', join(opencode, 'opencode.jsonc')),
    ...skills(fs, 'opencode', join(opencode, 'skills')),
  ];
}
