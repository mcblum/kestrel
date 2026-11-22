// How far a sign-in started from Kestrel has got (agents/sign-in.ts). Pure and browser-safe: the
// server answers with it and the page draws it.

export type SignInProgress =
  /** Nothing started, or the last one was cancelled. */
  | { state: 'idle' }
  /** The agent's program is waiting on the browser. `url`: the page, once it has said which. */
  | { state: 'waiting'; url: string | null }
  | { state: 'done' }
  | { state: 'failed'; reason: string };

export const NO_SIGN_IN: SignInProgress = { state: 'idle' };

/** A route's answer as progress; anything else reads as a failure with a reason. */
export function asSignInProgress(raw: unknown): SignInProgress {
  const r = raw as { state?: unknown; url?: unknown; reason?: unknown } | null;
  if (r?.state === 'idle' || r?.state === 'done') return { state: r.state };
  if (r?.state === 'waiting') return { state: 'waiting', url: typeof r.url === 'string' && r.url.startsWith('https://') ? r.url : null };
  return { state: 'failed', reason: typeof r?.reason === 'string' && r.reason ? r.reason : 'Kestrel could not read how the sign-in went.' };
}
