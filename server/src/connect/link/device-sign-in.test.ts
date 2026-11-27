// Polling a device authorization grant: the wait between polls, slow_down, expiry, refusal and cancelling.
import { describe, expect, test } from 'vitest';
import { tokensFor } from './connect-fakes.ts';
import { DEVICE_SIGN_IN_CANCELLED, pollDeviceGrant } from './device-sign-in.ts';
import { DEVICE_CODE_EXPIRED, DEVICE_SIGN_IN_DENIED, DeviceGrantEnded, SLOW_DOWN_MS, type DeviceAuthorization, type DevicePoll } from './identity.ts';

type Answer = 'pending' | 'slow-down' | 'signed-in' | 'expired' | 'denied';
const DEVICE_CANCEL_TEXT = DEVICE_SIGN_IN_CANCELLED;

/** Polls a scripted provider with a clock that moves only by the waits; records each wait. */
function pollWith(answers: Answer[], opts: { expiresAfterPolls?: number; cancelAfterPolls?: number } = {}) {
  let clock = 0;
  let polls = 0;
  const waits: number[] = [];
  const abort = new AbortController();
  const request: DeviceAuthorization = { verificationUri: 'https://id.example.test/device', verificationUriComplete: null, userCode: 'WDJB-MJHT', intervalMs: 5_000, expiresAt: 600_000, deviceCode: 'dc', verifier: 'v' };
  const identity = {
    devicePoll: async (): Promise<DevicePoll> => {
      polls += 1;
      if (opts.expiresAfterPolls === polls) clock = request.expiresAt;
      if (opts.cancelAfterPolls === polls) abort.abort();
      const next = answers.shift() ?? 'pending';
      if (next === 'expired') throw new DeviceGrantEnded(DEVICE_CODE_EXPIRED);
      if (next === 'denied') throw new DeviceGrantEnded(DEVICE_SIGN_IN_DENIED);
      return next === 'signed-in' ? { state: 'signed-in', tokens: tokensFor(1, clock) } : { state: next };
    },
  };
  const sleep = async (ms: number) => {
    waits.push(ms);
    clock += ms;
  };
  return { result: pollDeviceGrant({ identity, now: () => clock, sleep }, request, abort.signal), waits, polls: () => polls };
}

describe('pollDeviceGrant', () => {
  test('waits the interval between polls and comes back with the tokens', async () => {
    // Arrange: two polls pending, then signed in.
    const run = pollWith(['pending', 'pending', 'signed-in']);
    // Act
    const tokens = await run.result;
    // Assert
    expect(tokens.subject).toBe('sub-1');
    expect(run.waits).toEqual([5_000, 5_000, 5_000]);
  });

  test('slow_down lengthens every wait after it by five seconds', async () => {
    const run = pollWith(['slow-down', 'pending', 'slow-down', 'signed-in']);
    await run.result;
    expect(run.waits).toEqual([5_000, 5_000 + SLOW_DOWN_MS, 5_000 + SLOW_DOWN_MS, 5_000 + 2 * SLOW_DOWN_MS]);
  });

  test('an expired code says so plainly', async () => {
    await expect(pollWith(['pending', 'expired']).result).rejects.toThrow(DEVICE_CODE_EXPIRED);
  });

  test('the code running out before it is used says it expired, without asking again', async () => {
    const run = pollWith(['pending', 'pending'], { expiresAfterPolls: 1 });
    await expect(run.result).rejects.toThrow(DEVICE_CODE_EXPIRED);
    expect(run.polls()).toBe(1);
  });

  test('a sign-in refused on the other device says so plainly', async () => {
    await expect(pollWith(['denied']).result).rejects.toThrow(DEVICE_SIGN_IN_DENIED);
  });

  test('cancelling stops the polling and says it was cancelled', async () => {
    const run = pollWith(['pending', 'pending', 'pending'], { cancelAfterPolls: 1 });
    await expect(run.result).rejects.toThrow(DEVICE_CANCEL_TEXT);
    expect(run.polls()).toBe(1);
  });
});
