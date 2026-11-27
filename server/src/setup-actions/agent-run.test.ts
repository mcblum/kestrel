import { describe, expect, test } from 'vitest';
import { agentCommandPlan, runAgentCommand } from './agent-run.ts';
import type { RunOptions } from './io.ts';

const HOME = '/home/someone';

describe('a command an agent asked to run', () => {
  test('runs in the home folder by default, or a folder inside it; never outside', () => {
    expect(agentCommandPlan(['brew', 'install', 'uv'], undefined, HOME)).toEqual({ cwd: HOME });
    expect(agentCommandPlan(['git', 'status'], '~/Code/wren', HOME)).toEqual({ cwd: `${HOME}/Code/wren` });
    expect(() => agentCommandPlan(['ls'], '/etc', HOME)).toThrow(/inside the home folder/);
    expect(() => agentCommandPlan(['ls'], '~/../other', HOME)).toThrow(/inside the home folder/);
  });

  test('is refused when it needs an administrator', () => {
    expect(() => agentCommandPlan(['sudo', 'apt', 'install', 'x'], undefined, HOME)).toThrow(/paste into their terminal instead/);
  });

  test('runs from its argument list with git told not to ask, and answers the exit code and last output', async () => {
    const calls: { argv: readonly string[]; options: RunOptions }[] = [];
    const answer = await runAgentCommand({ home: HOME, run: async (argv, options) => (calls.push({ argv, options }), options.output?.('installed uv\n'), { code: 0, problem: null }) }, ['brew', 'install', 'uv'], HOME);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['brew', 'install', 'uv']);
    expect(calls[0]!.options).toMatchObject({ cwd: HOME, timeoutMs: 600_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    expect(calls[0]!.options.stdin).toBeUndefined();
    expect(answer).toBe('It ended with exit code 0.\nLast output:\ninstalled uv');
  });
});
