// How an OpenCode turn ends, as Kestrel's terminal event. Pure.
import type { AgentEvent } from '../types.ts';
import { realTokens, type TurnTokens } from '../../shared/plan-usage.ts';

export interface TurnOutcome {
  /** The error OpenCode reported for the turn (`session.error`, the message's `error`). */
  error: string | null;
  /** The last assistant text: a plan, in Plan. */
  text: string;
  costUsd: number;
  /** The turn's tokens, when its steps reported any. */
  tokens?: TurnTokens | null;
}

/** OpenCode's name for an aborted turn: a stop, not a failure. */
const ABORTED = /MessageAbortedError|aborted/i;
/** Errors the user fixes by signing in to a provider. */
const AUTH = /ProviderAuthError|unauthori[sz]ed|api key|401|403|auth/i;

/** `done` or `failed` for a turn that ran. `gaveUp` is Kestrel's own reason for ending it (a retry hours away). */
export function turnEnd(outcome: TurnOutcome, stopping: boolean, gaveUp: string | null, costUsd: number, tokens?: TurnTokens | null): Extract<AgentEvent, { type: 'done' | 'failed' }> {
  const counted = realTokens(tokens);
  const cost = { ...(costUsd > 0 ? { costUsd } : {}), ...(counted ? { tokens: counted } : {}) };
  if (gaveUp) return { type: 'failed', reason: gaveUp, kind: 'other' };
  if (stopping) return { type: 'done', reason: 'stopped', ...cost };
  if (outcome.error && !ABORTED.test(outcome.error)) return { type: 'failed', reason: `OpenCode: ${outcome.error}`, kind: AUTH.test(outcome.error) ? 'auth' : 'other' };
  if (outcome.error) return { type: 'done', reason: 'stopped', ...cost };
  return { type: 'done', reason: 'complete', ...cost };
}
