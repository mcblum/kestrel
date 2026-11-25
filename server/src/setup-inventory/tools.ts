// The tools a machine needs, read from what needs them: a project's files (onboarding.md 4.8), the
// programs MCP servers run, and the programs Claude's hooks run. Each is looked for on this machine
// the way agents are (`agents/find-program.ts`); nothing is installed.
import { join } from 'node:path';
import type { Platform } from '../shared/platform.ts';
import type { SetupTool } from '../shared/setup-record.ts';
import type { FsRead } from './io.ts';

export interface ToolNeed {
  name: string;
  why: string;
}

/** The program that answers for a tool, when its name is not the program's. */
const PROGRAM: Record<string, string> = { bundler: 'bundle' };
const XCODE = 'Xcode';

/** What a project folder's files say it needs. Pure over what `fs` reads. */
export function projectNeeds(fs: FsRead, project: string, dir: string): ToolNeed[] {
  const needs: ToolNeed[] = [];
  const has = (name: string) => fs.exists(join(dir, name));
  const add = (name: string, file: string, version?: string) => needs.push({ name, why: `${version ? `${name}@${version}` : name} in ${project}'s ${file}` });
  const pkg = fs.text(join(dir, 'package.json'));
  if (pkg !== null) {
    add('node', 'package.json');
    try {
      const manager = (JSON.parse(pkg) as { packageManager?: unknown }).packageManager;
      const m = typeof manager === 'string' ? /^(pnpm|yarn|bun)@([^+\s]+)/.exec(manager) : null;
      if (m) add(m[1]!, 'package.json', m[2]);
    } catch {
      // A package.json that does not parse still needs Node.
    }
  }
  for (const file of ['.nvmrc', '.node-version']) {
    const version = fs.text(join(dir, file))?.trim();
    if (version) add('node', file, version.replace(/^v/, ''));
  }
  if (has('.tool-versions')) add('asdf', '.tool-versions');
  if (has('mise.toml') || has('.mise.toml')) add('mise', 'mise.toml');
  if (has('Package.swift')) add(XCODE, 'Package.swift');
  if (has('project.yml')) {
    add(XCODE, 'project.yml');
    add('xcodegen', 'project.yml');
  }
  if (fs.list(dir).some((e) => e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace'))) add(XCODE, 'Xcode project');
  if (has('Gemfile')) {
    add('ruby', 'Gemfile');
    add('bundler', 'Gemfile');
  }
  if (has('uv.lock')) add('uv', 'uv.lock');
  else if (has('pyproject.toml')) add('uv', 'pyproject.toml');
  return needs;
}

/** The program an MCP server or a hook runs, as a tool: `uvx` is uv's, `npx` is Node's. Null for a path or nothing known. */
export function commandTool(command: string): string | null {
  const word = command.trim().split(/\s+/)[0] ?? '';
  if (!word || /[/\\]/.test(word) || word.startsWith('$') || word.startsWith('~')) return null;
  if (word === 'uvx' || word === 'uv') return 'uv';
  if (word === 'npx' || word === 'node') return 'node';
  if (word === 'bunx') return 'bun';
  if (/^(bash|sh|zsh|cat|echo|true|test|jq|python3?|osascript|afplay|say|git)$/.test(word)) return word === 'git' || word === 'jq' ? word : null;
  return word;
}

/** The programs Claude's hooks run, from its settings file. Pure. */
export function hookCommands(settingsText: string | null): string[] {
  if (!settingsText) return [];
  try {
    const hooks = (JSON.parse(settingsText) as { hooks?: unknown }).hooks;
    const out: string[] = [];
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (typeof v === 'object' && v !== null) {
        const command = (v as { command?: unknown }).command;
        if (typeof command === 'string') out.push(command);
        Object.values(v).forEach(visit);
      }
    };
    visit(hooks);
    return out;
  } catch {
    return [];
  }
}

/** The needs merged by tool, each looked for on this machine. */
export function toolsOf(needs: readonly ToolNeed[], platform: Platform, found: (program: string) => boolean, fs: FsRead): SetupTool[] {
  const byName = new Map<string, string[]>();
  for (const need of needs) byName.set(need.name, [...new Set([...(byName.get(need.name) ?? []), need.why])]);
  return [...byName.entries()]
    .map(([name, why]) => ({ name, why, found: name === XCODE ? platform === 'mac' && fs.exists('/Applications/Xcode.app') : found(PROGRAM[name] ?? name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
