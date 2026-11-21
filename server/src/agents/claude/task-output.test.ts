import { describe, expect, it } from 'vitest';
import { readTaskOutput, withinTime } from './task-output.ts';

describe('readTaskOutput', () => {
  it('gives up with a reason when the CLI never answers (seen live), instead of waiting forever', async () => {
    // Like the SDK's private request: settles only when answered, rejects when its signal aborts.
    const silent = { request: (_req: unknown, opts?: { signal?: AbortSignal }) => new Promise((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('Control request aborted')))) };
    await expect(readTaskOutput(silent, 'b1', 30)).rejects.toThrow('Claude did not say within 0.03 seconds.');
  });

  it('returns what the CLI answers', async () => {
    const answers = { request: async () => ({ output: 'tick 3\n', truncated: true }) };
    expect(await readTaskOutput(answers, 'b1')).toEqual({ text: 'tick 3\n', truncated: true });
  });
});

describe('withinTime', () => {
  it('passes the answer through, or rejects with the reason once the time is up', async () => {
    expect(await withinTime(Promise.resolve(1), 50, 'late')).toBe(1);
    await expect(withinTime(new Promise(() => {}), 20, 'Claude did not confirm stopping it')).rejects.toThrow('Claude did not confirm stopping it');
  });
});
