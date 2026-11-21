import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundStopFailed } from '../types.ts';
import { NO_ANSWER, NO_RUN, STOP_TASK_TIMEOUT_MS, stopClaudeTask, stopFailure } from './stop-task.ts';

afterEach(() => vi.useRealTimers());

describe('what a failed stop_task means', () => {
  it('reads the CLI’s own refusals (SDK 0.3.322)', () => {
    expect(stopFailure(new Error('Task b7 is not running (status: completed)'))).toMatchObject({ why: 'ended', endedAs: 'completed' });
    expect(stopFailure(new Error('Task b7 is not running (status: killed)'))).toMatchObject({ why: 'ended', endedAs: 'stopped' });
    expect(stopFailure(new Error('Task b7 is not running (status: failed)'))).toMatchObject({ why: 'ended', endedAs: 'failed' });
    expect(stopFailure(new Error('No task found with ID: b7. Running teammates: x'))).toMatchObject({ why: 'unknown' });
    expect(stopFailure(new Error('Task b7 is owned by helper; agent main cannot stop it.'))).toMatchObject({ why: 'refused', message: 'Task b7 is owned by helper; agent main cannot stop it.' });
    expect(stopFailure(new Error(NO_ANSWER))).toMatchObject({ why: 'no-answer' });
    expect(stopFailure('odd')).toMatchObject({ why: 'refused', message: 'odd' });
  });
});

describe('asking the CLI to stop one task', () => {
  it('asks the query to stop it, by task id', async () => {
    const stopped: string[] = [];
    await stopClaudeTask({ stopTask: async (id) => void stopped.push(id) }, 'b7');
    expect(stopped).toEqual(['b7']);
  });
  it('says the work already ended when the run is over', async () => {
    await expect(stopClaudeTask(null, 'b7')).rejects.toMatchObject({ why: 'ended', message: NO_RUN });
  });
  it('gives up when the CLI does not answer, saying so', async () => {
    vi.useFakeTimers();
    const asked = stopClaudeTask({ stopTask: () => new Promise<void>(() => undefined) }, 'b7');
    const seen = asked.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(STOP_TASK_TIMEOUT_MS + 1);
    const error = await seen;
    expect(error).toBeInstanceOf(BackgroundStopFailed);
    expect(error).toMatchObject({ why: 'no-answer' });
  });
  it('passes a CLI refusal on, classified', async () => {
    await expect(stopClaudeTask({ stopTask: async () => Promise.reject(new Error('Task b7 is not running (status: completed)')) }, 'b7')).rejects.toMatchObject({ why: 'ended', endedAs: 'completed' });
  });
});
