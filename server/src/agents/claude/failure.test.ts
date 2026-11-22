import { describe, expect, it } from 'vitest';
import { claudeAvailability, claudeFailure, claudeThrown, CLAUDE_NOT_FOUND } from './failure.ts';
import { claudeInstalled, claudeSignInAdvice } from './sign-in.ts';

/** The advice for this computer, as `claudeFailure` words it by default. */
const CLAUDE_SIGN_IN = `${claudeSignInAdvice(claudeInstalled())} Then send again.`;

describe('how a Claude failure is told', () => {
  it('says how to sign in when the failure is about signing in', () => {
    for (const reason of ['Failed to authenticate', 'Please run /login', 'Not logged in', 'OAuth token has expired', 'Invalid API key · fix external key']) {
      expect(claudeFailure(reason)).toEqual({ type: 'failed', reason: `${reason}. ${CLAUDE_SIGN_IN}`, kind: 'auth' });
    }
  });

  it("trusts the SDK's own authentication_failed whatever the text says", () => {
    expect(claudeFailure('Something went wrong', 'authentication_failed')).toMatchObject({ kind: 'auth', reason: `Something went wrong. ${CLAUDE_SIGN_IN}` });
    expect(claudeFailure('', 'authentication_failed').reason).toBe(CLAUDE_SIGN_IN);
  });

  it('ends the reason with one full stop before the instruction', () => {
    expect(claudeFailure('Not logged in.').reason).toBe(`Not logged in. ${CLAUDE_SIGN_IN}`);
  });

  it('says the program is missing when it could not be run', () => {
    expect(claudeThrown(new Error('spawn /Applications/Kestrel.app/claude ENOENT'))).toEqual({ type: 'failed', reason: `${CLAUDE_NOT_FOUND} (spawn /Applications/Kestrel.app/claude ENOENT)`, kind: 'other' });
    expect(claudeThrown('Claude Code executable not found at /x/claude').reason).toContain(CLAUDE_NOT_FOUND);
    // A turn that failed on a missing file of its own is not a missing program.
    expect(claudeFailure('ENOENT: no such file, open notes.md').reason).toBe('ENOENT: no such file, open notes.md');
    expect(claudeThrown(new Error('Not logged in'))).toMatchObject({ kind: 'auth' });
  });

  it('leaves any other failure as the agent gave it', () => {
    expect(claudeFailure('Rate limit reached')).toEqual({ type: 'failed', reason: 'Rate limit reached', kind: 'other' });
  });
});

describe('whether Claude can start a session', () => {
  const signedIn = async () => true;
  const signedOut = async () => false;
  const onlyDesktop = () => ({ desktop: true, cli: false });

  it('can when the SDK finds its own program and it is signed in', async () => {
    expect(await claudeAvailability({}, () => false, signedIn)).toEqual({ available: true });
  });

  it('cannot when the program Kestrel was told to run is not there', async () => {
    const env = { KESTREL_CLAUDE_EXECUTABLE: '/gone/claude' };
    expect(await claudeAvailability(env, () => true, signedIn)).toEqual({ available: true });
    expect(await claudeAvailability(env, () => false, signedIn)).toEqual({ available: false, reason: `${CLAUDE_NOT_FOUND} (/gone/claude)` });
  });

  it('cannot when it is not signed in, and says Kestrel can sign it in', async () => {
    expect(await claudeAvailability({}, () => true, signedOut, onlyDesktop)).toEqual({ available: false, reason: claudeSignInAdvice(onlyDesktop()), signIn: true });
  });

  it('lets a session start when the program cannot say whether it is signed in', async () => {
    expect(await claudeAvailability({}, () => true, async () => null)).toEqual({ available: true });
    expect(await claudeAvailability({}, () => true, () => Promise.reject(new Error('no answer')))).toEqual({ available: true });
  });
});

describe('the sign-in advice on a failed turn', () => {
  it('is worded for what this computer has', () => {
    const reason = claudeFailure('Not logged in', undefined, () => ({ desktop: true, cli: false })).reason;
    expect(reason).toContain('Claude desktop app');
    expect(claudeFailure('Not logged in', undefined, () => ({ desktop: true, cli: true })).reason).toContain('`claude`');
  });
});
