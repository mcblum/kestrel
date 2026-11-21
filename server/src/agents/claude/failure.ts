// How a Claude failure is told to the user: one place decides whether it is about signing in or a
// missing program, and adds what to do about it. Everything that ends a Claude turn with an error
// (an SDK message, a result) goes through `claudeFailure`; a thrown error through `claudeThrown`.
import { existsSync } from 'node:fs';
import type { AgentEvent } from '../types.ts';
import { CLAUDE_EXECUTABLE_ENV } from './executable.ts';

type Failed = Extract<AgentEvent, { type: 'failed' }>;
type Env = Record<string, string | undefined>;

export const CLAUDE_SIGN_IN = 'Claude is not signed in: run `claude` in a terminal, sign in with /login, then send again.';
export const CLAUDE_NOT_FOUND = 'Kestrel could not run Claude Code, the program its Claude sessions run on. Reinstall Kestrel, or from a checkout run `pnpm install`, then send again.';

const AUTH_PATTERN = /authenticat|\/login|not logged in|oauth|invalid api key/i;
const NOT_FOUND_PATTERN = /\bENOENT\b|executable not found|native binary .*not found/i;
/** The SDK's own name for a sign-in failure on an assistant message. */
const SDK_AUTH_ERROR = 'authentication_failed';

/** The agent's own words, ended with one full stop, then what to do. */
const withAdvice = (reason: string, advice: string): string => {
  const said = reason.replace(/[.\s]+$/, '');
  return said ? `${said}. ${advice}` : advice;
};

/** A Claude failure as the `failed` event the runtime shows. `sdkError` is the SDK's error code, when it gave one. */
export function claudeFailure(reason: string, sdkError?: string): Failed {
  if (sdkError === SDK_AUTH_ERROR || AUTH_PATTERN.test(reason)) return { type: 'failed', reason: withAdvice(reason, CLAUDE_SIGN_IN), kind: 'auth' };
  return { type: 'failed', reason, kind: 'other' };
}

/**
 * An error thrown while running Claude (not one the agent reported in a turn): the same, and also
 * a program that could not be run. Only here, since a turn may fail on a missing file of its own.
 */
export function claudeThrown(error: unknown): Failed {
  const reason = error instanceof Error ? error.message : String(error);
  if (NOT_FOUND_PATTERN.test(reason)) return { type: 'failed', reason: `${CLAUDE_NOT_FOUND} (${reason})`, kind: 'other' };
  return claudeFailure(reason);
}

/**
 * Whether a Claude session can start. Only the program is checked: asking whether Claude is signed
 * in means starting it, so a sign-in problem shows when the first turn fails, with what to do.
 */
export function claudeAvailability(env: Env = process.env, exists: (path: string) => boolean = existsSync): { available: boolean; reason?: string } {
  const path = env[CLAUDE_EXECUTABLE_ENV];
  if (!path || exists(path)) return { available: true };
  return { available: false, reason: `${CLAUDE_NOT_FOUND} (${path})` };
}
