// Ending a background command's processes found by the output file they write to. The system is a
// fake: no real process is looked up or signalled.
import { describe, expect, it } from 'vitest';
import { ancestors, commandProcesses, killTaskProcesses, type Proc, type ProcessSystem } from './kill-task.ts';

const FILE = '/tmp/claude-501/x/tasks/b7.output';

// launchd 1 → Electron 10 → Kestrel 20 → claude 30 → shell 40 → node 50 → esbuild 60; an unrelated 70.
const TABLE: Proc[] = [
  { pid: 10, ppid: 1, comm: '/Applications/Kestrel.app/Contents/MacOS/Kestrel' },
  { pid: 20, ppid: 10, comm: 'node' },
  { pid: 30, ppid: 20, comm: '/x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' },
  { pid: 40, ppid: 30, comm: '/bin/zsh' },
  { pid: 50, ppid: 40, comm: 'node' },
  { pid: 60, ppid: 50, comm: 'esbuild' },
  { pid: 70, ppid: 1, comm: 'vim' },
];

function fakeSystem(opts: { holders: number[]; stubborn?: number[] }) {
  const alive = new Set(TABLE.map((p) => p.pid));
  const signals: [number, string][] = [];
  const sys: ProcessSystem = {
    holders: async () => opts.holders,
    table: async () => TABLE,
    signal: (pid, signal) => {
      if (!alive.has(pid)) return false;
      signals.push([pid, signal]);
      if (signal === 'SIGKILL' || !(opts.stubborn ?? []).includes(pid)) alive.delete(pid);
      return true;
    },
    alive: (pid) => alive.has(pid),
    self: 20,
    sleep: async () => undefined,
  };
  return { sys, signals };
}

describe('which processes are the command', () => {
  it('walks up from a process', () => {
    expect([...ancestors(40, TABLE)]).toEqual([40, 30, 20, 10, 1]);
  });
  it('is the holders and everything under them, never Kestrel, its ancestors or the agent CLI', () => {
    // The CLI (30) and Kestrel (20) hold the file too: neither is ended.
    expect(commandProcesses([20, 30, 40, 50], TABLE, 20)).toEqual([40, 50, 60]);
    expect(commandProcesses([30], TABLE, 20)).toEqual([]);
  });
});

describe('ending the command', () => {
  it('sends SIGTERM to each of its processes', async () => {
    const { sys, signals } = fakeSystem({ holders: [30, 40] });
    expect(await killTaskProcesses(FILE, sys)).toEqual({ ended: [40, 50, 60], forced: [] });
    expect(signals).toEqual([[40, 'SIGTERM'], [50, 'SIGTERM'], [60, 'SIGTERM']]);
  });
  it('sends SIGKILL to what is still there after the grace', async () => {
    const { sys, signals } = fakeSystem({ holders: [40], stubborn: [50] });
    expect(await killTaskProcesses(FILE, sys)).toEqual({ ended: [40, 50, 60], forced: [50] });
    expect(signals.at(-1)).toEqual([50, 'SIGKILL']);
  });
  it('ends nothing when nothing holds the file, or the path is not a task output file', async () => {
    expect(await killTaskProcesses(FILE, fakeSystem({ holders: [] }).sys)).toEqual({ ended: [], forced: [] });
    const { sys, signals } = fakeSystem({ holders: [40] });
    expect(await killTaskProcesses('/Users/me/notes.txt', sys)).toEqual({ ended: [], forced: [] });
    expect(signals).toEqual([]);
  });
});
