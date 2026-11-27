// A worker node's sign-in to Kestrel Connect (worker-nodes.md, section 5): a device authorization grant, polled
// until the person signs in on another device, the code expires, or the sign-in is refused or cancelled. The
// tokens come back to the caller, which keeps them in the protected store; nothing here stores, prints or logs a
// token, the device code or the PKCE verifier.
import { DEVICE_CODE_EXPIRED, DeviceGrantEnded, SLOW_DOWN_MS, type DeviceAuthorization, type IdentityProvider } from './identity.ts';
import type { StoredTokens } from './vault.ts';

export const DEVICE_SIGN_IN_CANCELLED = 'The sign-in was cancelled.';

export interface PollDeps {
  identity: Pick<IdentityProvider, 'devicePoll'>;
  now?(): number;
  /** Waits `ms`; resolves early (to stop) when `signal` aborts. Default: a timer. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

/**
 * Polls `request` at its interval, longer by `SLOW_DOWN_MS` each time the provider asks (RFC 8628, 3.5), and
 * resolves with the tokens. Rejects with `DeviceGrantEnded` (expired, refused, cancelled) or the provider's error.
 */
export async function pollDeviceGrant(deps: PollDeps, request: DeviceAuthorization, signal: AbortSignal): Promise<StoredTokens> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  let interval = request.intervalMs;
  for (;;) {
    await sleep(interval, signal);
    if (signal.aborted) throw new DeviceGrantEnded(DEVICE_SIGN_IN_CANCELLED);
    if (now() >= request.expiresAt) throw new DeviceGrantEnded(DEVICE_CODE_EXPIRED);
    const answer = await deps.identity.devicePoll(request);
    if (signal.aborted) throw new DeviceGrantEnded(DEVICE_SIGN_IN_CANCELLED);
    if (answer.state === 'signed-in') return answer.tokens;
    if (answer.state === 'slow-down') interval += SLOW_DOWN_MS;
  }
}

/** What the person is shown of a device authorization: never the device code or the verifier. */
export type DeviceSignInPrompt = Pick<DeviceAuthorization, 'verificationUri' | 'verificationUriComplete' | 'userCode' | 'expiresAt'>;

export const promptOf = (request: DeviceAuthorization): DeviceSignInPrompt => ({ verificationUri: request.verificationUri, verificationUriComplete: request.verificationUriComplete, userCode: request.userCode, expiresAt: request.expiresAt });
