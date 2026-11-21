// A stand-in for node-pty, so terminal tests never start a real shell.
import type { Pty, SpawnPty } from './terminals.ts';

export type FakeShell = {
  shell: string;
  args: string[];
  options: { cwd: string; cols: number; rows: number; env: Record<string, string> };
  written: string[];
  sizes: [number, number][];
  killed: boolean;
  /** What node-pty would report as the foreground program. */
  process: string;
  emit(data: string): void;
  end(code: number): void;
};

export function fakePty(): { spawn: SpawnPty; spawned: FakeShell[] } {
  const spawned: FakeShell[] = [];
  const spawn: SpawnPty = (shell, args, options) => {
    let onData: (d: string) => void = () => undefined;
    let onExit: (e: { exitCode: number }) => void = () => undefined;
    const record: FakeShell = { shell, args, options, written: [], sizes: [], killed: false, process: shell.split('/').pop()!, emit: (d) => onData(d), end: (code) => onExit({ exitCode: code }) };
    spawned.push(record);
    const pty: Pty = {
      onData: (l) => (onData = l),
      onExit: (l) => (onExit = l),
      write: (d) => void record.written.push(d),
      resize: (c, r) => void record.sizes.push([c, r]),
      kill: () => (record.killed = true),
      get process() {
        return record.process;
      },
    };
    return pty;
  };
  return { spawn, spawned };
}
