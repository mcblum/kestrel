// The standing instruction reaches OpenCode as an instruction file (the config's `instructions`),
// which OpenCode adds to the system prompt of every turn, of every agent, sub-agents and slash
// commands included (a prompt's `system` field would reach the turns Kestrel sends a prompt for, but
// not a command's). The file lives in a private temporary folder of the process's own, owner-only,
// and is removed with the process. Nothing is written into the session's folder.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeInstruction } from './config.ts';

export interface InstructionFile {
  path: string;
  /** Removes the folder. Safe to call more than once. */
  remove(): void;
}

export function writeInstruction(text: string, base: string = tmpdir()): InstructionFile {
  const dir = mkdtempSync(join(base, 'kestrel-opencode-'));
  const path = join(dir, 'kestrel-instruction.md');
  writeFileSync(path, opencodeInstruction(text), { mode: 0o600 });
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
