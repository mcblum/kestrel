import { describe, expect, it } from 'vitest';
import { NAME_MAX_CHARS } from './background-tasks.ts';
import { cutInShell, taskRowName } from './task-row-name.ts';

const command = (line: string) => ({ id: 't', kind: 'command' as const, description: line, command: line });

describe('a command row name', () => {
  it('is the whole first line of a loop, not a cut at a shell word', () => {
    expect(taskRowName(command('for i in $(seq 1 10); do echo $i; sleep 1; done'))).toBe('for i in $(seq 1 10); do echo $i; sleep 1; done');
  });

  it('clips a long first line at the name length with an ellipsis', () => {
    const name = taskRowName(command('while true; do curl -s http://localhost:4317/health > /dev/null && break; sleep 1; done'));
    expect(name.length).toBe(NAME_MAX_CHARS);
    expect(name.startsWith('while true; do curl')).toBe(true);
    expect(name.endsWith('…')).toBe(true);
  });

  it('uses only the first line of a script', () => {
    expect(taskRowName(command('if [ -f x ]; then\n  cat x\nfi'))).toBe('if [ -f x ]; then');
  });

  it('keeps the short name of a plain command', () => {
    expect(taskRowName(command('cd api && pnpm --filter @app/api dev'))).toBe('pnpm dev (@app/api)');
  });

  it("keeps the agent's own words", () => {
    expect(taskRowName({ ...command('for f in *; do :; done'), label: 'Touch every file' })).toBe('Touch every file');
  });

  it('knows a name cut inside shell syntax', () => {
    expect(['for i in $(seq', 'echo `date', '( cd x', 'pnpm dev (@app/api)', 'sleep 90'].map(cutInShell)).toEqual([true, true, true, false, false]);
  });
});
